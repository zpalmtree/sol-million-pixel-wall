import { LAMPORTS_PER_SOL } from '@solana/web3.js';

export const SERVER_PORT = 4981;

export const CANVAS_WIDTH = 1000;
export const CANVAS_HEIGHT = 1000;

export const BRICKS_PER_ROW = 100;
export const BRICKS_PER_COLUMN = 100;

export const BRICK_WIDTH = CANVAS_WIDTH / BRICKS_PER_ROW;
export const BRICK_HEIGHT = CANVAS_HEIGHT / BRICKS_PER_COLUMN;


export const CORS_WHITELIST: string[] = [
    'build.wallonsolana.com',
];

export const JITO_FEE = 30_000;

export const PRICE_PER_BRICK = 0.25 * LAMPORTS_PER_SOL;
export const PRICE_PER_BRICK_EDIT = 0.1 * LAMPORTS_PER_SOL;

export const FUNDS_DESTINATION = '9hLBcTppq5DUziXTnuUtorbzKSDzM8cFz3FSvUgD8Nsf';
//export const FUNDS_DESTINATION = '9KvFNdRAQGC5LgvmjkZMkc3yfvohwYkoch5KpFgGLLdT';

export const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];
