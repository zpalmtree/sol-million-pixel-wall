import 'dotenv/config';
import pgPromise from 'pg-promise';
import * as url from 'url';
import * as fs from 'fs/promises';

import { DB, Brick } from './Types.js';
import { logger } from './Logger.js';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

export async function getDB(): Promise<DB> {
    const { db } = await getDBWithContext();
    return db;
}

export async function getDBWithContext() {
    const pg = pgPromise({});

    pg.pg.types.setTypeParser(20, BigInt);

    const db = pg({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        idleTimeoutMillis: 60 * 60 * 1000,
    });

    await createTables(db);
    
    return { db, pg };
}

export async function createTables(db: DB) {
    logger.debug(`Creating any missing tables...`);

    await createWallBricksTable(db);
    await loadBricksFromJSON(db);
    await createEditBricksTable(db);
}

async function loadBricksFromJSON(db: DB) {
    try {
        const filePath = `${__dirname}/../bricks.json`;
        const data = await fs.readFile(filePath, 'utf8');
        const bricksData: Brick[] = JSON.parse(data);

        const result = await db.any('SELECT x, y FROM wall_bricks');
        const existingCoordinates = new Set(result.map((r: any) => `${r.x},${r.y}`));

        const newBricks = bricksData.filter(brick => brick.assetId && !existingCoordinates.has(`${brick.column},${brick.row}`));

        if (newBricks.length > 0) {
            logger.debug(`Loading ${newBricks.length} new bricks into the wall_bricks table.`);

            const insertQuery = `
                INSERT INTO wall_bricks (x, y, assetId, purchased, image_location, url)
                VALUES ($1, $2, $3, $4, $5, $6)
            `;

            const promises = newBricks.filter((b) => b.assetId).map(brick => {
                return db.none(
                    insertQuery,
                    [
                        brick.column,
                        brick.row,
                        brick.assetId,
                        false,
                        null,
                        null,
                    ]
                );
            });

            await Promise.all(promises);

            logger.debug('New bricks loaded into the wall_bricks table.');
        } else {
            logger.debug('No new bricks to load.');
        }
    } catch (error) {
        logger.error('Error loading bricks:', error);
    }
}

async function createWallBricksTable(db: DB) {
    await db.none(
        `CREATE TABLE IF NOT EXISTS wall_bricks (
            id BIGSERIAL PRIMARY KEY,

            x INTEGER NOT NULL,

            y INTEGER NOT NULL,

            assetId VARCHAR(255) NOT NULL,

            purchased BOOLEAN NOT NULL,

            image_location VARCHAR(255),

            url VARCHAR(2000),

            CONSTRAINT unique_coordinates UNIQUE(x, y)
        )`
    );
}

async function createEditBricksTable(db: DB) {
    await db.none(
        `CREATE TABLE IF NOT EXISTS edit_bricks (
            id BIGSERIAL PRIMARY KEY,

            username VARCHAR(255) NOT NULL,

            transaction_hash VARCHAR(255) NOT NULL UNIQUE
        )`
    );
}
