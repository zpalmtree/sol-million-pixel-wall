import 'dotenv/config';
import * as fs from 'fs/promises';
import {
    Keypair,
    Connection,
} from '@solana/web3.js';

import { ImageManipulation } from './ImageManipulation.js';
import { WrappedConnection } from './WrappedConnection.js';
import { Api } from './Api.js';
import { PixelWall } from './PixelWall.js';
import { logger } from './Logger.js';
import { getDB } from './Database.js';

async function main() {
    logger.info(`Initializing`);

    if (!process.env.RPC_ADDRESS || !process.env.PRIVATE_KEY_PATH) {
        logger.error(`Missing required ENV args!`);
        return;
    }

    const connection = new Connection(process.env.RPC_ADDRESS);
    const connectionWrapper = new WrappedConnection(process.env.RPC_ADDRESS);
    const wallet = await loadSeed(process.env.PRIVATE_KEY_PATH);

    logger.info(`Initializing DB...`);

    const db = await getDB();

    logger.info(`Initializing pixel wall...`);

    const pixelWall = new PixelWall(
        db,
    );

    await pixelWall.init();

    logger.info(`Launching API...`);

    const api = new Api(
        pixelWall,
        db,
        wallet,
        connection,
        connectionWrapper,
    );

    await api.start();

    logger.info(`API started.`);
}

async function loadSeed(filename: string): Promise<Keypair> {
    const privateKey = JSON.parse((await fs.readFile(filename, { encoding: 'utf-8' })));
    const wallet = Keypair.fromSecretKey(new Uint8Array(privateKey));
    return wallet;
}


main();
