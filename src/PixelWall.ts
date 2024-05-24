import { StaticCanvas } from 'fabric/node';

import { DB } from './Types.js';
import { ImageManipulation } from './ImageManipulation.js';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from './Constants.js';

export class PixelWall {
    private initialized: boolean = false;

    private canvas = new StaticCanvas();

    private imageManipulation = new ImageManipulation();

    private cachedCanvasImage: string | undefined = undefined;

    constructor(private db: DB) {
    }

    public async init() {
        if (this.initialized) {
            return;
        }

        await this.restoreWallFromDB();

        this.initialized = true;
    }

    /* Renders image to data URL */
    public async renderImage(): Promise<string> {
        if (!this.initialized) {
            throw new Error('Canvas has not been initialized yet!');
        }

        if (!this.cachedCanvasImage) {
            const renderedImage = await this.canvas.toDataURL({
                multiplier: 1,
            });

            this.cachedCanvasImage = renderedImage;
        }

        return this.cachedCanvasImage;
    }

    private async restoreWallFromDB() {
        this.canvas.setDimensions({
            width: CANVAS_WIDTH,
            height: CANVAS_HEIGHT,
        });
    }
}
