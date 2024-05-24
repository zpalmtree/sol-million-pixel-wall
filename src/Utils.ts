import { PROGRAM_ID } from "@metaplex-foundation/mpl-bubblegum";
import { PublicKey } from '@solana/web3.js';

export function pickRandomItem<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
}

export async function getBubblegumAuthorityPDA(merkleRollPubKey: PublicKey) {
    const [bubblegumAuthorityPDAKey] = await PublicKey.findProgramAddress(
        [merkleRollPubKey.toBuffer()],
        PROGRAM_ID,
    );
    return bubblegumAuthorityPDAKey;
}

export function bufferToArray<T extends ArrayLike<number>>(buffer: T): number[] {
    const nums = [];

    for (let i = 0; i < buffer.length; i++) {
        nums.push(buffer[i]);
    }

    return nums;
}
