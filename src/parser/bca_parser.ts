import { TextItem } from "pdfjs-dist/types/src/display/api";
import { FnAskPassword, FnUpdatePassword, TrxRecord } from "./shared";
import pdfjs from './pdfjs';

export async function parseBCAStatement(
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

	const allRecs: TrxRecord[] = [];
	for (let pageNum = 1; pageNum <= pdfdoc.numPages; pageNum++) {
		const page = await pdfdoc.getPage(pageNum);
		const txts = await page.getTextContent();
		const items = txts.items as TextItem[];
		const recs = parseBCAItems(items);
		allRecs.push(...recs);
	}

	return allRecs;
}

const dateRgx: RegExp = /^(0[1-9]|[12][0-9]|3[01])\/(0[1-9]|1[0-2])$/;
const moneyRgx: RegExp = /^\d{1,3}(,\d{3})*\.\d{2}$/;

export function parseBCAItems(items: TextItem[] = []): TrxRecord[] {
	// Extract period information
	const periodeIdx = items.findIndex((rec: TextItem) => rec.str === "PERIODE");
	if (periodeIdx === -1) {
		return [];
	}
	
	// Look for period in the next few items
	let periode = "";
	for (let i = periodeIdx + 1; i < periodeIdx + 10 && i < items.length; i++) {
		if (items[i].str.includes("20")) { // Look for year
			periode = items[i].str;
			break;
		}
	}
	
	// Parse year from period
	const periodParts = periode.trim().split(" ");
	const tahun = parseInt(periodParts[periodParts.length - 1], 10);
	
	// Find transaction table start
	const tanggalHeaderIdx = items.findIndex((rec: TextItem) => rec.str === "TANGGAL");

	if (tanggalHeaderIdx === -1) {
		return [];
	}

	// Ensure "KETERANGAN" exists within a reasonable range
	const keteranganIdx = items.findIndex(
		(r: TextItem, idx: number) =>
			idx > tanggalHeaderIdx - 5 &&
			idx < tanggalHeaderIdx + 5 &&
			r.str === "KETERANGAN"
	);

	if (keteranganIdx === -1) {
		return [];
	}

	
	// Find the first date entry after headers
	let startRowIdx = -1;
	for (let i = tanggalHeaderIdx + 1; i < items.length; i++) {
		if (dateRgx.test(items[i].str)) {
			startRowIdx = i;
			break;
		}
	}
	
	if (startRowIdx === -1) {
		return [];
	}

	const txrecs: TrxRecord[] = [];
	let currentRecord: TrxRecord | null = null;
	let currentIdx = startRowIdx;
	
	while (currentIdx < items.length) {
		const item = items[currentIdx];
		
		// Check if we've reached the end of the transaction list
		if (item.str.toLowerCase().includes("saldo awal :") || 
			item.str.toLowerCase().includes("bersambung ke halaman")) {
			break;
		}
		
		// New transaction starts with a date
		if (dateRgx.test(item.str)) {
			// Save previous record if exists
			if (currentRecord && currentRecord.tgl) {
				txrecs.push(currentRecord);
			}
			
			// Initialize new record
			currentRecord = {
				tahun,
				tgl: item.str,
				ket: "",
				type: "credit", // Default, will be updated
				mutasi: 0.0,
				saldo: 0.0
			};
			
			currentIdx++;
			
			// Get transaction description
			if (currentIdx < items.length) {
				currentRecord.ket = items[currentIdx].str;
				currentIdx++;
			}
			
			// Skip branch code if present
			if (currentIdx < items.length && items[currentIdx].str === "CBG") {
				currentIdx += 2; // Skip "CBG" and its value
			}
			
			// Process next items to find amount and balance
			let foundMutasi = false;
			const detailLines = [];
			
			while (currentIdx < items.length) {
				const nextItem = items[currentIdx];
				
				// If we encounter a new date, break out
				if (dateRgx.test(nextItem.str)) {
					break;
				}
				
				// Collect detail lines for the transaction
				if (!foundMutasi && !moneyRgx.test(nextItem.str)) {
					detailLines.push(nextItem.str);
				}
				
				// Process money amount
				if (moneyRgx.test(nextItem.str)) {
					const amount = parseFloat(nextItem.str.replace(/,/g, ""));
					
					// Check if this is followed by "DB" (debit)
					if (currentIdx + 1 < items.length && items[currentIdx + 2].str === "DB") {
						currentRecord.type = "debit";
						currentRecord.mutasi = amount;
						currentIdx += 2; // Skip past "DB"
						foundMutasi = true;
					} else {
						// This is credit or balance
						if (!foundMutasi) {
							currentRecord.type = "credit";
							currentRecord.mutasi = amount;
							foundMutasi = true;
						} else {
							// This should be the balance
							currentRecord.saldo = amount;
							currentIdx++;
							break;
						}
						currentIdx++;
					}
				} else {
					currentIdx++;
				}
				
				// Break if we've encountered the end marker
				if (nextItem.str.toLowerCase().includes("saldo awal :") || 
					nextItem.str.toLowerCase().includes("bersambung ke halaman")) {
					break;
				}
			}
			
			// Add detail lines to the description
			if (detailLines.length > 0) {
				if (currentRecord.ket) {
					currentRecord.ket += " " + detailLines.join(" ").trim();
				} else {
					currentRecord.ket = detailLines.join(" ").trim();
				}
			}
			
			// Handle special case for "SALDO AWAL"
			if (currentRecord.ket.toUpperCase() === "SALDO AWAL") {
				currentRecord.type = "saldo_awal";
			}
		} else {
			// This might be additional description for the current transaction
			if (currentRecord && !dateRgx.test(item.str) && 
				!moneyRgx.test(item.str) && 
				item.str !== "DB" && 
				item.str !== "CR") {
				currentRecord.ket += " " + item.str;
			}
			currentIdx++;
		}
	}
	
	// Add the last record if it exists
	if (currentRecord && currentRecord.tgl) {
		txrecs.push(currentRecord);
	}

	return txrecs;
}