export type TrxRecord = {
	tahun: number;
	tgl: string;
	ket: string;
	type: "debit" | "credit" | "saldo_awal";
	mutasi: number;
	saldo: number;
};

export type FnAskPassword = () => string;

export type FnUpdatePassword = (password: string) => void;