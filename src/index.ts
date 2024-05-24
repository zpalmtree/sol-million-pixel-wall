import 'dotenv/config';

import { ImageManipulation } from './ImageManipulation.js';
import { Api } from './Api.js';
import { PixelWall } from './PixelWall.js';
import { logger } from './Logger.js';
import { getDB } from './Database.js';

async function main() {
    logger.info(`Initializing`);

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
    );

    await api.start();

    logger.info(`API started.`);
}

main();
