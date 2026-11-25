/**
 * The `MailboxAdapter` the rest of the Worker uses: every call goes to the mailbox's
 * `MailboxVault` over RPC, which holds the tokens and enforces the limits. A failed operation
 * becomes `MailError(code)`; a failure of the RPC call itself becomes `MailError("internal")`.
 */
import {
  MAIL_ERROR_CODES,
  MailError,
  type MailboxAdapter,
  type MailErrorCode,
  type MoveMailRequestT,
  type OutgoingMessage,
  type ReadThreadInputT,
  type SearchMailInputT,
} from "../mail";
import type { Env } from "../env";
import { type MailboxVault, vaultFor } from "./mailbox-vault";

type Stub = DurableObjectStub<MailboxVault>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isErrorCode = (v: unknown): v is MailErrorCode => (MAIL_ERROR_CODES as readonly unknown[]).includes(v);

export class VaultMailbox implements MailboxAdapter {
  readonly #env: Env;
  readonly #accountId: string;
  readonly #email: string;

  /** `accountId` and `email` are the grant's: the vault answers `account_mismatch` unless both match. */
  constructor(env: Env, accountId: string, email: string) {
    this.#env = env;
    this.#accountId = accountId;
    this.#email = email;
  }

  listMailboxes() {
    return this.#call<Awaited<ReturnType<MailboxAdapter["listMailboxes"]>>>((v, id, email) => v.listMailboxes(id, email));
  }

  searchMail(input: SearchMailInputT) {
    return this.#call<Awaited<ReturnType<MailboxAdapter["searchMail"]>>>((v, id, email) => v.searchMail(id, email, input));
  }

  readThread(input: ReadThreadInputT) {
    return this.#call<Awaited<ReturnType<MailboxAdapter["readThread"]>>>((v, id, email) => v.readThread(id, email, input));
  }

  createDraft(input: OutgoingMessage) {
    return this.#call<Awaited<ReturnType<MailboxAdapter["createDraft"]>>>((v, id, email) =>
      v.createDraft(id, email, input),
    );
  }

  moveMail(input: MoveMailRequestT) {
    return this.#call<Awaited<ReturnType<MailboxAdapter["moveMail"]>>>((v, id, email) => v.moveMail(id, email, input));
  }

  sendMail(input: OutgoingMessage) {
    return this.#call<Awaited<ReturnType<MailboxAdapter["sendMail"]>>>((v, id, email) => v.sendMail(id, email, input));
  }

  /** Unwraps a `VaultResult`; anything that is not one is `internal`. */
  async #call<T>(rpc: (vault: Stub, accountId: string, email: string) => Promise<unknown>): Promise<T> {
    let answer: unknown;
    try {
      answer = await rpc(vaultFor(this.#env, this.#accountId), this.#accountId, this.#email);
    } catch {
      throw new MailError("internal");
    }
    if (isObject(answer) && answer.ok === true && "value" in answer) return answer.value as T;
    if (isObject(answer) && answer.ok === false && isErrorCode(answer.code)) throw new MailError(answer.code);
    throw new MailError("internal");
  }
}
