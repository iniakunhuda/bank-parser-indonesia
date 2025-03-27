import { TextItem } from "pdfjs-dist/types/src/display/api";
import { FnAskPassword, FnUpdatePassword, TrxRecord } from "./shared";
import pdfjs from './pdfjs';
import dayjs from 'dayjs';

export async function parseMandiriCCStatement(
	buf: ArrayBuffer,
	askPassword: FnAskPassword,
	askRetryPassword: FnAskPassword,
): Promise<TrxRecord[]> {
	const loadingTask = pdfjs.getDocument(buf);
	loadingTask.onPassword = (
		updatePassword: FnUpdatePassword,
		reason: number,
	) => {
		if (reason === pdfjs.PasswordResponses.NEED_PASSWORD) {
			const password = askPassword();
			updatePassword(password);
		}
		if (reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD) {
			const password = askRetryPassword();
			updatePassword(password);
		}
	};

	const pdfdoc = await loadingTask.promise;

	const allItems: TextItem[] = []

	const allRecs: TrxRecord[] = [];
	for (let pageNum = 1; pageNum <= pdfdoc.numPages; pageNum++) {
		const page = await pdfdoc.getPage(pageNum);
		const txt = await page.getTextContent();

		const items = txt.items as TextItem[];
		allItems.push(...items)

		const recs = parseMandiriCCItems(items);
        if (!recs || recs.length === 0) {
            continue;
        }

		allRecs.push(...recs);
	}

	console.log(allItems)

	return allRecs;
}

const dateRgx: RegExp = /^\d{1,2}-[a-zA-Z]{3}-\d{2}$/;
const saldoRgx: RegExp = /^\d{1,3}(,\d{3})*\.\d{2}$/;

export function parseTahun(textItems: TextItem[] = []): number {
	const periodeIdx = textItems.findIndex(
		(rec: TextItem) => rec.str.toLowerCase() === "payment due date",
	);

	const periode = textItems[periodeIdx + 4].str;
    
    const date = dayjs(periode, "DD-MMM-YY")
	return date.year();
}

export function parseMandiriCCItems(
	textItems: TextItem[] = [],
): TrxRecord[] {

	const trxDateIdx = textItems.findIndex(
		(rec: TextItem) => rec.str.toLowerCase() === "transaction date",
	);

    if (trxDateIdx === -1) {
        return [];
    }

    
	const items = textItems.slice(trxDateIdx, textItems.length);

    const tagihanBlnLaluIdx = items.findIndex(
        (rec: TextItem) => rec.str.toLowerCase() === "tagihan bulan lalu",
    );

	const startIdx: number = tagihanBlnLaluIdx+3;
	const rows: string[][] = [];

	// build rows
	let rowsIdx: number = startIdx;
	while (rowsIdx < items.length) {
		const row: string[] = [];
		let i: number = rowsIdx;
		for (; i < items.length; i++) {
			rowsIdx++;
			const rec: TextItem = items[i];
			if (rec.hasEOL) {
				if (rec.str.trim() !== "") {
					row.push(rec.str);
				}
				break;
			}
			if (rec.str.trim() === "") {
				continue;
			}

			row.push(rec.str);
		}
		if (row.length === 0) {
			continue;
		}

		rows.push(row);
	}

	const txrecs: TrxRecord[] = [];

	// build tx records
	for (const row of rows) {
		const txrec: TrxRecord = {
			tahun: 0,
			ket: "",
			tgl: "",
			type: "saldo_awal",
			mutasi: 0.0,
			saldo: 0.0,
		};

		let i = 0;
		while (i < row.length) {
			if (row[i].trim() === "") {
				i++;
				continue;
			}

			if (dateRgx.test(row[i])) {
				const date = parseTgl(row[i]);
                txrec.tgl = date.format("DD/MM");
                txrec.tahun = date.year();
				i++;
				continue;
			}

			const isNextNextEOL: boolean = i + 2 === row.length;
			const isNextNextSaldo: boolean =
				!isNextNextEOL && saldoRgx.test(row[i + 2]);
			const isMutasi: boolean = saldoRgx.test(row[i]);
            
			if (isMutasi) {
				txrec.type = "debit";

                const idx = i;

				txrec.mutasi = parseFloat(row[idx].replace(/,/g, ""));
				i++;

                const isDebit = row[idx + 1] && row[idx + 1].trim() === "CR";
                if (isDebit) {
                    txrec.type = "credit";
                    i++;
                }

				if (isNextNextSaldo) {
					txrec.saldo = parseFloat(row[i + 1].replace(/,/g, ""));
					i += 2;
				}
				continue;
			}

			// build keterangan
			txrec.ket += `${row[i]} `;
			i++;
		}

		if (txrec.ket && txrec.ket !== "") {
			txrec.ket = txrec.ket.trim();
		}

		// stop
		const str = txrec.ket.trim().toLowerCase();
		const stopwords = ["sub-total"];
		if (stopwords.includes(str)) {
			break;
		}

		// part of previous txrec ketrangan
		if ((!txrec.tgl || txrec.tgl === "") && txrec.ket !== "") {
			if (txrecs.length === 0 || !txrecs[txrecs.length - 1]) {
				continue;
			}
			txrecs[txrecs.length - 1].ket += ` ${txrec.ket}`;
			continue;
		}

		txrecs.push(txrec);
	}

	return txrecs;
}

function parseTgl(tgl: string): dayjs.Dayjs {
    return dayjs(tgl, "DD-MMMM-YY");
}