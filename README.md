# Bank Report Parser Indonesia

This project is a simple web application that converts bank statements into Table format. It supports various bank formats and allows users to select the type of statement, upload the PDF, and read the parsed transactions in Table format.

## Features

-   Parses bank statements from:
    -   **BCA Debit Statements**
    -   **Mandiri Debit Statements**
    -   **Mandiri Credit Card Statements**
-   Converts parsed data into CSV format for easy download.
-   Provides user prompts for password-protected PDF statements.
-   Automatically detects and formats certain transaction descriptions (e.g., for popular services like GoPay, ShopeePay).

## Technologies Used

-   **React** with TypeScript for the UI and state management.
-   **Mantine UI** for UI components (button, table, etc.).
-   **@fahmifan/bank-statement-parser-id** for bank statement parsing.
-   **json2csv** for converting JSON data into CSV format.
-   **@tabler/icons-react** for icons.

## Getting Started

### Prerequisites

-   **Node.js** and **npm** installed on your machine.

### Installation

1. Clone the repository:

    ```bash
    git clone https://github.com/iniakunhuda/bank-parser-indonesia.git
    cd bank-report-converter
    ```

2. Install dependencies:
    ```bash
    npm install
    ```

### Running the Application

To start the application, run:

```bash
npm start
```

The app will be available at http://localhost:3000.

### Building for Production

To build the app for production, run:

```bash
npm run build
```

The built files will be in the build directory.

## Usage

1. Select the type of bank statement from the dropdown menu (e.g., BCA Debit Statement, Mandiri Debit Statement).
2. Click on "Upload Bank Report" to upload your bank statement PDF.
3. If the PDF is password-protected, you’ll be prompted to enter the password.
4. After the statement is parsed, a table will display the transaction details.
5. Click "Download CSV" to export the transactions as a CSV file.

## Contributing

Contributions are welcome! Please create a pull request with a detailed description of your changes.

## License

This project is licensed under the MIT License.
