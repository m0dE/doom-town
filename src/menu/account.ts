/**
 * Sign in with ARRR (the SDK's `identity`), lean: vibe-strike's account
 * without the wardrobe.
 *
 * Signing in buys a name on the network that is yours: the token goes to
 * `connect()`, the node stamps the join's userId from it, so the game MUST use
 * `session.userId` as the local player id (main.ts does). Optional - a guest
 * plays exactly the same, and nothing here may block Play.
 */
import { identity as sdkIdentity, type IdentitySession } from 'arrr-network';
import { APP_ID } from './rooms.js';

export type AccountStatus = 'guest' | 'signing-in' | 'signed-in';

export interface AccountState {
  status: AccountStatus;
  session: IdentitySession | null;
  /** One sentence for the player when the last attempt failed. */
  note: string | null;
}

const say = (err: unknown): string => {
  const m = err instanceof Error ? err.message : String(err);
  return /popup|closed|cancel/i.test(m) ? 'Sign-in was closed before it finished.' : `Could not sign in (${m}).`;
};

export class Account {
  private st: AccountState = { status: 'guest', session: null, note: null };
  private readonly listeners = new Set<(s: AccountState) => void>();

  constructor(private readonly central?: string) {
    sdkIdentity.onChange((session) => {
      if (session && this.st.session && session.token !== this.st.session.token && session.userId === this.st.session.userId) {
        this.set({ ...this.st, session });           // refreshed holders: same player
      }
    });
  }

  /** Pick up a sign-in this browser already has (also consumes a redirect's answer in the URL). */
  start(): void {
    try {
      const s = sdkIdentity.current({ appId: APP_ID });
      if (s) this.set({ status: 'signed-in', session: s, note: null });
    } catch (err) {
      this.set({ status: 'guest', session: null, note: say(err) });
    }
  }

  state(): AccountState { return this.st; }
  session(): IdentitySession | null { return this.st.session; }

  onChange(cb: (s: AccountState) => void): void { this.listeners.add(cb); cb(this.st); }

  async signIn(): Promise<void> {
    if (this.st.status === 'signing-in') return;
    this.set({ ...this.st, status: 'signing-in', note: null });
    try {
      const session = await sdkIdentity.login({ appId: APP_ID, ...(this.central ? { centralServiceUrl: this.central } : {}) });
      this.set({ status: 'signed-in', session, note: null });
    } catch (err) {
      this.set({ status: 'guest', session: null, note: say(err) });
    }
  }

  signOut(): void {
    try { sdkIdentity.logout({ appId: APP_ID }); } catch { /* already gone */ }
    this.set({ status: 'guest', session: null, note: null });
  }

  private set(s: AccountState): void {
    this.st = s;
    for (const l of this.listeners) { try { l(s); } catch (err) { console.error(err); } }
  }
}
