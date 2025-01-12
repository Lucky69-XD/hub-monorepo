import {
  HubError,
  HubEvent,
  isMergeMessageHubEvent,
  isMergeOnChainHubEvent,
  isMergeUsernameProofHubEvent,
  isPruneMessageHubEvent,
  isRevokeMessageHubEvent,
  isStorageRentOnChainEvent,
  Message,
  OnChainEventType,
  StorageRentOnChainEvent,
} from "@farcaster/hub-nodejs";
import { err, ok } from "neverthrow";
import RocksDB from "../db/rocksdb.js";
import { FID_BYTES, OnChainEventPostfix, RootPrefix, UserMessagePostfix } from "../db/types.js";
import { logger } from "../../utils/logger.js";
import { makeFidKey, makeMessagePrimaryKey, makeTsHash, typeToSetPostfix } from "../db/message.js";
import { bytesCompare, getFarcasterTime, HubAsyncResult } from "@farcaster/core";
import { forEachOnChainEvent } from "../db/onChainEvent.js";
import { addProgressBar } from "../../utils/progressBars.js";
import {
  rsClearEarliestTsHash,
  rsClearEarliestTsHashCache,
  rsCreateStorageCache,
  rsGetEarliestTsHash,
  RustStorageCache,
} from "../../rustfunctions.js";

const MAX_PENDING_MESSAGE_COUNT_SCANS = 100;

const makeKey = (fid: number, set: UserMessagePostfix): string => {
  return Buffer.concat([makeFidKey(fid), Buffer.from([set])]).toString("hex");
};

const log = logger.child({ component: "StorageCache" });

type StorageSlot = {
  units: number;
  invalidateAt: number;
};

export class StorageCache {
  private _db: RocksDB;
  private _counts: Map<string, number>;
  private _pendingMessageCountScans = new Map<string, Promise<number>>();

  private _activeStorageSlots: Map<number, StorageSlot>;

  private _rustStorageCache: RustStorageCache;

  constructor(db: RocksDB, usage?: Map<string, number>) {
    this._counts = usage ?? new Map();
    this._activeStorageSlots = new Map();
    this._db = db;
    this._rustStorageCache = rsCreateStorageCache(db.rustDb);
  }

  get rustStorageCache(): RustStorageCache {
    return this._rustStorageCache;
  }

  async syncFromDb(): Promise<void> {
    log.info("starting storage cache sync");

    const start = Date.now();
    rsClearEarliestTsHashCache(this._rustStorageCache);

    const totalFids = await this._db.countKeysAtPrefix(
      Buffer.concat([Buffer.from([RootPrefix.OnChainEvent, OnChainEventPostfix.IdRegisterByFid])]),
    );

    const progressBar = addProgressBar("Syncing storage cache", totalFids * 2);

    const time = getFarcasterTime();
    if (time.isErr()) {
      log.error({ err: time.error }, "could not obtain time");
    } else {
      await forEachOnChainEvent(this._db, OnChainEventType.EVENT_TYPE_STORAGE_RENT, (event) => {
        const existingSlot = this._activeStorageSlots.get(event.fid);
        if (isStorageRentOnChainEvent(event) && event.storageRentEventBody.expiry > time.value) {
          const rentEventBody = event.storageRentEventBody;
          this._activeStorageSlots.set(event.fid, {
            units: rentEventBody.units + (existingSlot?.units ?? 0),
            invalidateAt:
              (existingSlot?.invalidateAt ?? rentEventBody.expiry) < rentEventBody.expiry
                ? existingSlot?.invalidateAt ?? rentEventBody.expiry
                : rentEventBody.expiry,
          });
          progressBar?.increment();
        }
      });
    }

    progressBar?.update(progressBar?.getTotal());
    progressBar?.stop();

    this._counts = new Map();

    // Start prepopulating the cache in the background
    if (this._db.status !== "open") {
      log.error("cannot prepopulate message counts, db is not open");
      throw new HubError("unavailable.storage_failure", "cannot prepopulate message counts, db is not open");
    }

    log.info({ timeTakenMs: Date.now() - start }, "storage cache synced");
  }

  async getMessageCount(fid: number, set: UserMessagePostfix, forceFetch = true): HubAsyncResult<number> {
    const key = makeKey(fid, set);

    const pendingPromise = this._pendingMessageCountScans.get(key);
    if (pendingPromise) {
      return ok((await pendingPromise) ?? 0);
    }

    if (this._counts.get(key) === undefined && forceFetch) {
      if (this._pendingMessageCountScans.size > MAX_PENDING_MESSAGE_COUNT_SCANS) {
        return err(new HubError("unavailable.storage_failure", "too many pending message count scans"));
      }

      const countPromise = new Promise<number>((resolve) => {
        (async () => {
          const total = await this._db.countKeysAtPrefix(makeMessagePrimaryKey(fid, set));

          // We should maybe turn this into a LRU cache, otherwise it scales by the number
          // of fids*set types.
          this._counts.set(key, total);

          resolve(total);
          this._pendingMessageCountScans.delete(key);
        })();
      });

      this._pendingMessageCountScans.set(key, countPromise);
      return ok(await countPromise);
    } else {
      return ok(this._counts.get(key) ?? 0);
    }
  }

  async getCurrentStorageUnitsForFid(fid: number): HubAsyncResult<number> {
    let slot = this._activeStorageSlots.get(fid);

    if (!slot) {
      return ok(0);
    }

    const time = getFarcasterTime();

    if (time.isErr()) {
      return err(time.error);
    }

    if (slot.invalidateAt < time.value) {
      const newSlot = { units: 0, invalidateAt: time.value + 365 * 24 * 60 * 60 };
      await forEachOnChainEvent(
        this._db,
        OnChainEventType.EVENT_TYPE_STORAGE_RENT,
        (event) => {
          if (isStorageRentOnChainEvent(event)) {
            const rentEventBody = event.storageRentEventBody;
            if (rentEventBody.expiry < time.value) return;
            if (newSlot.invalidateAt > rentEventBody.expiry) {
              newSlot.invalidateAt = rentEventBody.expiry;
            }

            newSlot.units += rentEventBody.units;
          }
        },
        fid,
      );
      slot = newSlot;
      this._activeStorageSlots.set(fid, slot);
    }

    return ok(slot.units);
  }

  async getEarliestTsHash(fid: number, set: UserMessagePostfix): HubAsyncResult<Uint8Array | undefined> {
    const result = await rsGetEarliestTsHash(this._rustStorageCache, fid, set);
    if (result.isErr()) {
      return err(result.error);
    }
    if (result.value.length === 0) {
      return ok(undefined);
    } else {
      return ok(new Uint8Array(result.value));
    }
  }

  async processEvent(event: HubEvent): HubAsyncResult<void> {
    if (isMergeMessageHubEvent(event)) {
      await this.addMessage(event.mergeMessageBody.message);
      for (const message of event.mergeMessageBody.deletedMessages) {
        await this.removeMessage(message);
      }
    } else if (isPruneMessageHubEvent(event)) {
      await this.removeMessage(event.pruneMessageBody.message);
    } else if (isRevokeMessageHubEvent(event)) {
      await this.removeMessage(event.revokeMessageBody.message);
    } else if (isMergeUsernameProofHubEvent(event)) {
      if (event.mergeUsernameProofBody.usernameProofMessage) {
        await this.addMessage(event.mergeUsernameProofBody.usernameProofMessage);
      } else if (event.mergeUsernameProofBody.deletedUsernameProofMessage) {
        await this.removeMessage(event.mergeUsernameProofBody.deletedUsernameProofMessage);
      }
    } else if (isMergeOnChainHubEvent(event) && isStorageRentOnChainEvent(event.mergeOnChainEventBody.onChainEvent)) {
      this.addRent(event.mergeOnChainEventBody.onChainEvent);
    }
    return ok(undefined);
  }

  private async addMessage(message: Message): Promise<void> {
    if (message.data !== undefined) {
      const set = typeToSetPostfix(message.data.type);
      const fid = message.data.fid;
      const key = makeKey(fid, set);
      let count = this._counts.get(key);

      if (count === undefined) {
        const msgCountResult = await this.getMessageCount(fid, set);

        if (msgCountResult.isErr()) {
          log.error({ err: msgCountResult.error }, "could not get message count");
          return;
        }
        count = msgCountResult.value;
      }

      this._counts.set(key, count + 1);
    }
  }

  private async removeMessage(message: Message): Promise<void> {
    if (message.data !== undefined) {
      const set = typeToSetPostfix(message.data.type);
      const fid = message.data.fid;
      const key = makeKey(fid, set);

      let count = this._counts.get(key);
      if (count === undefined) {
        const msgCountResult = await this.getMessageCount(fid, set);
        if (msgCountResult.isErr()) {
          log.error({ err: msgCountResult.error }, "could not get message count");
          return;
        }
        count = msgCountResult.value;
      }

      this._counts.set(key, count - 1);
    }
  }

  private addRent(event: StorageRentOnChainEvent): void {
    if (event !== undefined) {
      const existingSlot = this._activeStorageSlots.get(event.fid);
      const time = getFarcasterTime();
      if (time.isErr()) {
        log.error({ err: time.error }, "could not obtain time");
        return;
      }

      const rentEventBody = event.storageRentEventBody;
      if (time.value > (existingSlot?.invalidateAt ?? 0)) {
        this._activeStorageSlots.set(event.fid, {
          units: rentEventBody.units,
          invalidateAt: rentEventBody.expiry,
        });
      } else {
        this._activeStorageSlots.set(event.fid, {
          units: rentEventBody.units + (existingSlot?.units ?? 0),
          invalidateAt:
            (existingSlot?.invalidateAt ?? rentEventBody.expiry) < rentEventBody.expiry
              ? existingSlot?.invalidateAt ?? rentEventBody.expiry
              : rentEventBody.expiry,
        });
      }
    }
  }
}
