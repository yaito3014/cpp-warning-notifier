declare module "gcc-output-parser" {
  export type OutputEntry = {
    filename: string;
    line: number;
    column: number;
    type: string;
    text: string;
    codeWhitespace: string;
    code: string;
    adjustedColumn: number;
    startIndex: number;
    endIndex: number;
    parentFunction: string | undefined;
  };
  export function parseString(input: string | Buffer): Array<OutputEntry>;
}
