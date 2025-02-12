import {
	Button,
	Container,
	FileInput,
	Group,
	Select,
	Table,
	Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { parseBCAStatement, parseMandiriCCStatement, parseMandiriStatement, TrxRecord } from "@fahmifan/bank-statement-parser-id";

import { IconDownload, IconUpload } from "@tabler/icons-react";
import { json2csv } from "json-2-csv";

type ParserKind = "bca_statement" | "mandiri_statement" | "mandiri_cc_statement";

export function App() {
	const [file, setFile] = useState<File | null>(null);
	const [trxRecords, setTrxRecords] = useState<TrxRecord[]>([]);
	const [parserKind, setParserKind] = useState<ParserKind>("bca_statement");

	const parserKinds: {
		value: ParserKind;
		label: string;
	}[] = [
			{ value: "bca_statement", label: "BCA Debit Statement" },
			{ value: "mandiri_statement", label: "Mandiri Debit Statement" },
			{ value: "mandiri_cc_statement", label: "Mandiri CC Statement" }
		];

	useEffect(() => {
		convertFiles();
	}, [file, parserKind]);

	function convertFiles() {
		if (!file) {
			return;
		}

		file
			?.arrayBuffer()
			.then((buf) => {
				return buf;
			})
			.then((buf) => {
				switch (parserKind) {
					case "bca_statement":
						return parseBCAStatement(
							buf,
							askPasswordPrompt,
							askRetryPasswordPrompt,
						);
					case "mandiri_statement":
						return parseMandiriStatement(
							buf,
							askPasswordPrompt,
							askRetryPasswordPrompt,
						);
					case "mandiri_cc_statement":
						return parseMandiriCCStatement(
							buf,
							askPasswordPrompt,
							askRetryPasswordPrompt,
						)
					default:
						return [];
				}
			})
			.then((res) => {
				setTrxRecords(res);
			});
	}

	function onChange(value: File | null) {
		setFile(value);
	}

	function askPasswordPrompt(): string {
		const pass = window.prompt(
			"The PDF is password protected. Please enter password to continue.",
		);
		return pass || "";
	}

	function askRetryPasswordPrompt(): string {
		const pass = window.prompt(
			"The password is incorrect. Please enter the correct password to continue.",
		);
		return pass || "";
	}

	function exportToCSV() {
		const records = trxRecords.map((rec) => {
			return {
				tgl: `${rec.tgl}/${rec.tahun}`,
				ket: rec.ket,
				type: rec.type,
				mutasi: rec.mutasi,
				saldo: rec.saldo,
			};
		});
		json2csv(records, {
			delimiter: {
				field: ",",
				wrap: '"',
				eol: "\n",
			},
		}).then((res) => {
			downloadCSV(
				res,
				replaceExtenstion(file?.name ?? "bank_statement", "csv"),
				"text/csv",
			);
		});
	}

	function replaceExtenstion(input: string, newExt: string): string {
		const parts = input.split(".");
		parts[parts.length - 1] = newExt;
		return parts.join(".");
	}

	return (
		<>
			<Container size="md">
				<Title>Bank Report Converter</Title>
				<Group py="md">
					<Select
						placeholder="Select Report Type"
						value={parserKind}
						onChange={(val) => {
							setParserKind(val as ParserKind);
						}}
						data={parserKinds}
					/>
					<FileInput
						value={file}
						icon={<IconUpload size={14} />}
						onChange={onChange}
						label="Upload Bank Report"
					/>
					<Button
						variant="outline"
						leftIcon={<IconDownload size={14} />}
						onClick={() => {
							exportToCSV();
						}}
					>
						Download CSV
					</Button>
				</Group>

				{trxRecords.length > 0 && (
					<Table highlightOnHover>
						<thead>
							<tr>
								<th>Tanggal</th>
								<th>Keterangan</th>
								<th>Mutasi</th>
								{/* <th>DB/CR</th> */}
							</tr>
						</thead>
						<tbody>
							{trxRecords.map((trxRecord, index) => {
								return (
									<tr
										key={trxRecord.ket + trxRecord.tgl + trxRecord.type + index}
									>
										<td>
											{trxRecord.tgl}/{trxRecord.tahun}
										</td>
										<td>{formatKeterangan(trxRecord.ket)}</td>
										<td style={{ color: getRecordColor(trxRecord) }}>
											{getMutationText(trxRecord)}
										</td>
										{/* <td>{trxRecord.type}</td> */}
									</tr>
								);
							})}
						</tbody>
					</Table>
				)}
			</Container>
		</>
	);
}

function rupiah(number: number): string {
	return new Intl.NumberFormat("id-ID", {
		style: "currency",
		currency: "IDR",
	}).format(number);
}

function getMutationText(record: TrxRecord): string {
	switch (record.type) {
		case "credit":
		case "saldo_awal":
			return `+${rupiah(record.mutasi)}`;
		default:
			return `-${rupiah(record.mutasi)}`;
	}
}

function getRecordColor(record: TrxRecord) {
	switch (record.type) {
		case "credit":
		case "saldo_awal":
			return "#2F9E44";
		case "debit":
			return "#FF0000";
		default:
			return "";
	}
}

function formatKeterangan(keterangan: string) {
	if (keterangan.includes("UBP60146073701FFFFFF")) {
		return keterangan + " **(GOJEK)**";
	} else if (keterangan.includes("UBP60148930801")) {
		return keterangan + " **(SHOPEEPAY)**";
	} else if (keterangan.includes("UBP6014530180")) {
		return keterangan + " **(PEMBAYARAN KAI)**";
	} else if (keterangan.includes("UBP6014400190")) {
		return keterangan + " **(MANDIRI PULSA)**";
	} else if (keterangan.includes("UBP60146000101FF")) {
		return keterangan + " **(GRAB / OVO)**";
	} else if (keterangan.includes("UBP60148890801F")) {
		return keterangan + " **(MIDTRANS)**";
	} else if (keterangan.includes("UBP6014603290")) {
		return keterangan + " **(E-MONEY)**";
	}

	return keterangan;
}

// downloadCSV takes a CSV string, the filename and mimeType as parameters
function downloadCSV(
	csvContent: string,
	fileName: string,
	fileMimeType: string,
) {
	const a = document.createElement("a");
	const mimeType = fileMimeType || "application/octet-stream";

	if (window.URL && "download" in a) {
		//html5 A[download]
		a.href = window.URL.createObjectURL(
			new Blob([csvContent], {
				type: mimeType,
			}),
		);
		a.setAttribute("download", fileName);
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	} else {
		location.href = `data:application/octet-stream, ${encodeURIComponent(
			csvContent,
		)}`; // only this mime type is supported
	}
}
