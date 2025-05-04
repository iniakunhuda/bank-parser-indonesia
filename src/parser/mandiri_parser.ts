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
    const allRecs: TrxRecord[] = [];
    
    // Extract year from first page
    const firstPage = await pdfdoc.getPage(1);
    const firstPageContent = await firstPage.getTextContent();
    const firstPageItems = firstPageContent.items as TextItem[];
    
    // Join all text to search for period and extract year
    const firstPageText = firstPageItems.map(item => item.str).join(' ');
    const periodMatch = firstPageText.match(/(\d{2}\s+[A-Za-z]{3}\s+\d{4})\s*-\s*(\d{2}\s+[A-Za-z]{3}\s+\d{4})/);
    let year = 2025; // Default
    
    if (periodMatch && periodMatch[1]) {
        const dateMatch = periodMatch[1].match(/\d{4}$/);
        if (dateMatch) {
            year = parseInt(dateMatch[0], 10);
        }
    }

    // Process each page
    for (let pageNum = 1; pageNum <= pdfdoc.numPages; pageNum++) {
        // Skip the last page if it's just a disclaimer
        if (pageNum === pdfdoc.numPages) {
            const lastPage = await pdfdoc.getPage(pageNum);
            const lastPageContent = await lastPage.getTextContent();
            const lastPageText = (lastPageContent.items as TextItem[])
                .map(item => item.str)
                .join(' ');
            
            if (lastPageText.toLowerCase().includes('disclaimer') && 
                !lastPageText.includes('Tanggal') && 
                !lastPageText.includes('Date')) {
                continue;
            }
        }

        const page = await pdfdoc.getPage(pageNum);
        const content = await page.getTextContent();
        const items = content.items as TextItem[];
        
        // Try all parsing methods for maximum coverage
        let pageRecs: TrxRecord[] = [];
        
        // First try standard parsing
        const standardRecs = parseMandiriPage(items, year);
        if (standardRecs.length > 0) {
            pageRecs = standardRecs;
        } else {
            // If standard parsing fails, try direct transactions parsing
            const directRecs = parseDirectTransactions(items, year);
            if (directRecs.length > 0) {
                pageRecs = directRecs;
            } else {
                // If both fail, try pattern-based parsing
                pageRecs = parsePatternBased(items, year);
            }
        }
        
        allRecs.push(...pageRecs);
    }

    return allRecs;
}

interface PositionedItem {
    text: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
}

function parseMandiriPage(items: TextItem[], year: number): TrxRecord[] {
    const txrecs: TrxRecord[] = [];
    
    // Convert TextItems to positioned items
    const posItems: PositionedItem[] = items.map(item => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height
    }));
    
    // Group by rows (y-position within tolerance)
    const rows = groupIntoRows(posItems);
    
    // Find table headers
    const headerRow = findHeaderRow(rows);
    if (headerRow === -1) return txrecs;
    
    // Extract transactions
    for (let i = headerRow + 1; i < rows.length; i++) {
        const row = rows[i];
        
        // Check if this is a transaction row (starts with a number)
        if (row.length === 0) continue;
        
        const firstCell = row[0].text;
        // Look for rows that start with a number (transaction ID)
        if (!/^\d+$/.test(firstCell)) continue;
        
        // Extract date
		const dateItem = row.find(item => 
			/^\d{2}\s+[A-Za-z]{3}\s+\d{4}$/.test(item.text) || 
			/^\d{2}\s+[A-Za-z]{3}\s+\d{4}\/\d{4}$/.test(item.text) // Also match the format with duplicate year
		);

		if (!dateItem) continue;

		// Clean up the date format if needed
		let dateText = dateItem.text;
		if (dateText.includes('/')) {
			dateText = dateText.split('/')[0];
		}
        
        // Look for amount (both negative and positive numbers in Indonesian format)
        const amountItem = row.find(item => 
            /^-[\d.,]+,\d{2}$/.test(item.text) || 
            /^\+[\d.,]+,\d{2}$/.test(item.text) ||
            /^[\d.,]+,\d{2}$/.test(item.text) // Also check for numbers without sign
        );
        
        if (!amountItem) continue;
        
        // Determine if it's negative (debit) or positive (credit)
        const isNegative = amountItem.text.startsWith('-');
        const amountStr = amountItem.text;
        
        // Parse amount (convert from Indonesian format)
        const amountClean = amountStr.replace(/\./g, '').replace(',', '.').replace(/[+-]/g, '');
        const amount = parseFloat(amountClean) * (isNegative ? -1 : 1);
        
        // Find balance (usually after amount, positive number)
        let balanceItem = null;
        
        // Sort remaining items by x-position to find the rightmost numeric item (likely balance)
        const remainingItems = row.filter(item => 
            item !== amountItem && 
            /^[\d.,]+,\d{2}$/.test(item.text)
        ).sort((a, b) => b.x - a.x);
        
        if (remainingItems.length > 0) {
            balanceItem = remainingItems[0];
        }
        
        if (!balanceItem) continue;
        
        // Parse balance (convert from Indonesian format)
        const balanceClean = balanceItem.text.replace(/\./g, '').replace(',', '.');
        const balance = parseFloat(balanceClean);
        
        // Extract description - use a different approach
        // Get all items between first cell and amount, sorted by x and y positions
        const descItems = row.filter(item => 
            item !== amountItem && 
            item !== balanceItem && 
            item !== dateItem &&
            !/^\d{2}:\d{2}:\d{2}\s+WIB$/.test(item.text) // Exclude time
        ).sort((a, b) => {
            // Sort by y-coordinate first (top to bottom)
            if (Math.abs(a.y - b.y) > 5) {
                return b.y - a.y;
            }
            // Then by x-coordinate (left to right)
            return a.x - b.x;
        });
        
        // Join all description items
        const description = descItems.map(item => item.text).join(' ').trim();
        
        // Determine transaction type
        let type: "debit" | "credit" | "saldo_awal" = isNegative ? "debit" : "credit";
        
        // Special case for saldo awal
        if (description.toLowerCase().includes('saldo awal')) {
            type = "saldo_awal";
        }
        
        // Create transaction record
        const txRec: TrxRecord = {
            tahun: year,
            tgl: dateText,
            ket: description,
            type,
            mutasi: Math.abs(amount), // Store absolute value
            saldo: balance
        };
        
        txrecs.push(txRec);
    }
    
    return txrecs;
}

function parseDirectTransactions(items: TextItem[], year: number): TrxRecord[] {
    const txrecs: TrxRecord[] = [];
    
    // Extract all numbers, dates, and potential descriptions
    const numbers: {text: string, x: number, y: number}[] = [];
    const dates: {text: string, x: number, y: number}[] = [];
    const allItems: {text: string, x: number, y: number}[] = [];
    
    for (const item of items) {
        const posItem = {
            text: item.str,
            x: item.transform[4],
            y: item.transform[5]
        };
        
        allItems.push(posItem);
        
        // Extract date patterns
        if (/^\d{2}\s+[A-Za-z]{3}\s+\d{4}$/.test(item.str)) {
            dates.push(posItem);
        }
        
        // Extract number patterns (Indonesian format) - include both signed and unsigned
        if (/^[-+]?[\d.,]+,\d{2}$/.test(item.str)) {
            numbers.push(posItem);
        }
    }
    
    // Process each date as a potential transaction
    for (const date of dates) {
        // Find numbers on the same line or within a line or two (similar y-coordinate with tolerance)
        const relatedNumbers = numbers.filter(num => 
            Math.abs(num.y - date.y) < 20
        ).sort((a, b) => a.x - b.x);
        
        if (relatedNumbers.length < 2) continue; // Need at least amount and balance
        
        // Rightmost number is typically the balance
        const balanceItem = relatedNumbers[relatedNumbers.length - 1];
        
        // Look for the amount: either the number with +/- sign or the second-to-last number
        let amountItem;
        for (const num of relatedNumbers) {
            if (num.text.startsWith('-') || num.text.startsWith('+')) {
                amountItem = num;
                break;
            }
        }
        
        // If no signed number found, use the second-to-last as amount
        if (!amountItem && relatedNumbers.length >= 2) {
            amountItem = relatedNumbers[relatedNumbers.length - 2];
        }
        
        if (!amountItem || !balanceItem) continue;
        
        // Parse balance
        const balanceClean = balanceItem.text.replace(/\./g, '').replace(',', '.');
        const balance = parseFloat(balanceClean);
        
        // Parse amount and determine transaction type
        const isNegative = amountItem.text.startsWith('-');
        const amountClean = amountItem.text.replace(/\./g, '').replace(',', '.').replace(/[+-]/g, '');
        const amount = parseFloat(amountClean);
        
        // Extract description - collect items near the date and amount
        // Get all items in the vicinity of the transaction
        // Extract description - get items that are clearly part of this transaction
		const nearbyItems = allItems.filter(item => {
			// Base criteria: within a reasonable vertical distance from the date
			const verticalMatch = Math.abs(item.y - date.y) < 25; // More strict vertical limit (2.5 lines)
			
			// Exclude standard items we don't want in description
			const notExcluded = item !== date &&
								item !== amountItem &&
								item !== balanceItem &&
								!/^\d{2}:\d{2}:\d{2}\s+WIB$/.test(item.text) && // Exclude time
								!/^[-+]?[\d.,]+,\d{2}$/.test(item.text);

			return verticalMatch && notExcluded;
		});

		// Join the description items
		let description = nearbyItems.map(item => item.text).join(' ').trim();

		description = description.replace(/\s+\d+\s*$/, '');
        
        // Determine transaction type
        let type: "debit" | "credit" | "saldo_awal";
        if (description.toLowerCase().includes('saldo awal')) {
            type = "saldo_awal";
        } else if (isNegative) {
            type = "debit";
        } else {
            type = "credit";
        }

		// remove year from dateText
		const dateParts = date.text.split(' ');
		const formattedDate = `${dateParts[0]} ${dateParts[1]}`;

        
        // Create transaction record
        const txRec: TrxRecord = {
            tahun: year,
            tgl: formattedDate,
            ket: description,
            type,
            mutasi: amount,
            saldo: balance
        };
        
        txrecs.push(txRec);
    }
    
    return txrecs;
}

// Helper function to group items into rows based on y-position
function groupIntoRows(items: PositionedItem[]): PositionedItem[][] {
    const rows: Map<number, PositionedItem[]> = new Map();
    
    // Group by y-position (rounded to nearest 2 pixels for tolerance)
    for (const item of items) {
        const rowKey = Math.round(item.y / 2) * 2;
        
        if (!rows.has(rowKey)) {
            rows.set(rowKey, []);
        }
        
        rows.get(rowKey)?.push(item);
    }
    
    // Convert to array and sort by y-position (top to bottom)
    return Array.from(rows.entries())
        .sort((a, b) => b[0] - a[0]) // Sort by y-position (descending)
        .map(([, rowItems]) => rowItems);
}

// Find the header row in the grouped rows
function findHeaderRow(rows: PositionedItem[][]): number {
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowTexts = row.map(item => item.text.toLowerCase());
        
        // Check if this row contains table headers
        if ((rowTexts.includes('no') && rowTexts.includes('tanggal')) || 
            (rowTexts.includes('no') && rowTexts.includes('date'))) {
            return i;
        }
    }
    
    return -1; // Header row not found
}

// Advanced pattern-based parser for the Mandiri format
export function parsePatternBased(items: TextItem[], year: number): TrxRecord[] {
    const txrecs: TrxRecord[] = [];
    
    // Extract all text with positions
    const allText = items.map(item => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5]
    }));
    
    // Create lines by sorting by Y position descending, then X ascending
    const yGroups = new Map<number, {text: string, x: number, y: number}[]>();
    
    for (const item of allText) {
        // Round Y to group similar positions
        const yKey = Math.round(item.y);
        
        if (!yGroups.has(yKey)) {
            yGroups.set(yKey, []);
        }
        
        yGroups.get(yKey)?.push(item);
    }
    
    // Sort each group by X
    yGroups.forEach(group => group.sort((a, b) => a.x - b.x));
    
    // Sort Y keys descending (top to bottom of page)
    const sortedY = Array.from(yGroups.keys()).sort((a, b) => b - a);
    
    // Reassemble as lines
    const lines = sortedY.map(y => yGroups.get(y) || []);
    
    // Process each line
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length === 0) continue;
        
        // Check if line starts with a number (transaction ID)
        if (!/^\d+$/.test(line[0].text)) continue;
        
        // Extract date
        const dateItem = line.find(item => /^\d{2}\s+[A-Za-z]{3}\s+\d{4}$/.test(item.text));
        if (!dateItem) continue;
        
        // Extract numbers (amount and balance)
        const numberItems = line.filter(item => /^-?[\d.,]+,\d{2}$/.test(item.text));
        if (numberItems.length < 2) continue;
        
        // Typically last number is balance, and the one before is amount
        const balanceItem = numberItems[numberItems.length - 1];
        const amountItem = numberItems[numberItems.length - 2];
        
        // Parse amount
        const isNegative = amountItem.text.startsWith('-');
        const amountValue = parseFloat(
            amountItem.text.replace(/\./g, '').replace(',', '.').replace(/[+-]/g, '')
        );
        
        // Parse balance
        const balanceValue = parseFloat(
            balanceItem.text.replace(/\./g, '').replace(',', '.')
        );
        
        // Extract description (items between transaction number and amount)
        let description = '';
        
        // Start collecting after transaction number and date
        const startX = Math.max(line[0].x, dateItem.x);
        
        // Collect text between start and amount
        for (const item of line) {
            if (item.x > startX && item.x < amountItem.x && 
                item !== dateItem && 
                !/^\d{2}:\d{2}:\d{2}\s+WIB$/.test(item.text)) {
                description += item.text + ' ';
            }
        }
        
        description = description.trim();
        
        // Determine transaction type
        let type: "debit" | "credit" | "saldo_awal" = isNegative ? "debit" : "credit";
        
        // Check for special types
        if (description.toLowerCase().includes('saldo awal')) {
            type = "saldo_awal";
        }
        
        // Create transaction record
        const txRec: TrxRecord = {
            tahun: year,
            tgl: dateItem.text,
            ket: description,
            type,
            mutasi: amountValue,
            saldo: balanceValue
        };
        
        txrecs.push(txRec);
    }
    
    return txrecs;
}