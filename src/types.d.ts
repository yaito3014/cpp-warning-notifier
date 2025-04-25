declare module "gcc-output-parser" {
  export function parseString(input: string | Buffer): Array<{
    filename: string;
    line: number;
    column: number;
    type: string;
    text: string;
    code: string;
    adjustedColumn: number;
  }>;
}
