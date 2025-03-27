import { TextItem } from "pdfjs-dist/types/src/display/api";
import { FnAskPassword, FnUpdatePassword, TrxRecord } from "./shared";
import pdfjs from './pdfjs';

export async function parseMandiriStatement(
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

	// find periode
	const page = await pdfdoc.getPage(1);
	const txt = await page.getTextContent();
	const textItems = txt.items as TextItem[];
	const tahun = parseTahun(textItems);

	const allRecs: TrxRecord[] = [];
	for (let pageNum = 1; pageNum <= pdfdoc.numPages; pageNum++) {
		const page = await pdfdoc.getPage(pageNum);
		const txts = await page.getTextContent();

		const items = txts.items as TextItem[];
		const recs = parseMandiriItems(tahun, items);
		allRecs.push(...recs);
	}

	return allRecs;
}

const dateRgx: RegExp = /^(0[1-9]|[12][0-9]|3[01])\/(0[1-9]|1[0-2])$/;
const debitRgx: RegExp = /^\d{1,3}(,\d{3})*\.\d{2} D$/;
const saldoRgx: RegExp = /^\d{1,3}(,\d{3})*\.\d{2}$/;

export function parseTahun(textItems: TextItem[] = []): number {
	const periodeIdx = textItems.findIndex(
		(rec: TextItem) => rec.str.toLowerCase() === "periode /",
	);
	const periode = textItems[periodeIdx + 5].str;
	const date = periode.split("s/d")[0];
	const yearStr = date.split("/")[2];
	const tahun = parseInt(yearStr, 10) + 2000;
	return tahun;
}

export function parseMandiriItems(
	tahun: number,
	textItems: TextItem[] = [],
): TrxRecord[] {
	// find saldo awal
	const trxDateIdx = textItems.findIndex(
		(rec: TextItem) => rec.str.toLowerCase() === "transaction",
	);
	let items = textItems.slice(trxDateIdx, textItems.length);
	const date1Idx = items.findIndex(
		(rec: TextItem) => rec.str.toLowerCase() === "date",
	);
	items = items.slice(date1Idx, items.length);

	const date2Idx = items.findIndex(
		(rec: TextItem) => rec.str.toLowerCase() === "date",
	);
	items = items.slice(date2Idx, items.length);

	const saldoIdx: number = items.findIndex(
		(rec: TextItem) => rec.str.toLowerCase() === "balance",
	);

	const startIdx: number = saldoIdx + 2;
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
				if (rec.str !== "") {
					row.push(rec.str);
				}
				break;
			}
			if (rec.str === "") {
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
			tahun,
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
				txrec.tgl = row[i];
				i++;
				continue;
			}

			const isNextNextEOL: boolean = i + 2 === row.length;
			const isNextNextSaldo: boolean =
				!isNextNextEOL && saldoRgx.test(row[i + 2]);
			const isCredit: boolean = saldoRgx.test(row[i]);
			const isDebit: boolean = debitRgx.test(row[i]);

			if (isCredit) {
				txrec.type = "credit";
				txrec.mutasi = parseFloat(row[i].replace(/,/g, ""));
				i++;

				if (isNextNextSaldo) {
					txrec.saldo = parseFloat(row[i + 1].replace(/,/g, ""));
					i += 2;
				}
				continue;
			}

			if (isDebit) {
				txrec.type = "debit";
				txrec.mutasi = parseFloat(row[i].replace(/,/g, ""));
				i++;

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
			if (txrec.ket.toLowerCase() === "saldo awal") {
				txrec.type = "saldo_awal";
			}
		}

		// stop
		const str = txrec.ket.trim().toLowerCase();
		const stopwords = [
			"saldo awal / previous balance :",
			"mutasi kredit / total of credit transactions :",
			"mutasi debit / total of debit transactions :",
			"saldo akhir / current balance :",
		];
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