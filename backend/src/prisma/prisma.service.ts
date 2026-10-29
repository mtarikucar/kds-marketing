import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { poolSizeFor } from "./pool-size";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  /** Connections in this client's pool. The cron locks size themselves
   *  against it — see common/scheduling/advisory-lock.ts. */
  readonly poolSize: number;

  constructor() {
    // v2.8.97 — query log is gated on an EXPLICIT env flag rather than
    // `NODE_ENV === 'development'`. Prisma's `query` log level emits
    // bound parameters alongside the SQL — password hashes, refresh
    // tokens, OTP codes, encrypted credentials all flow through Prisma
    // verbatim. Pre-fix a staging env with NODE_ENV=development (a
    // common misconfig when copying .env.example) would have streamed
    // every secret into the application logs. The new flag
    // PRISMA_LOG_QUERIES=true is opt-in; production refuses to honor
    // it even if set.
    const enableQueryLogs =
      process.env.PRISMA_LOG_QUERIES === "true" &&
      process.env.NODE_ENV !== "production";
    const url = process.env.DATABASE_URL;
    super({
      datasources: {
        db: {
          url,
        },
      },
      log: enableQueryLogs ? ["query", "error", "warn"] : ["error", "warn"],
    });
    this.poolSize = poolSizeFor(url);
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log("Database connected");
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log("Database disconnected");
  }

  async cleanDatabase() {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Cannot clean database in production");
    }

    const models = Reflect.ownKeys(this).filter((key) => key[0] !== "_");

    return Promise.all(models.map((modelKey) => this[modelKey].deleteMany()));
  }
}
