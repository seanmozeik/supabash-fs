// Browser-facing portion of just-bash's DNS pinning contract. The upstream
// declaration also exports internal Node test helpers that import all of Undici,
// including its node:buffer augmentation and Node type reference.
export interface PinnedAddress {
  hostname: string;
  address: string;
  family: 4 | 6;
}

export interface PinnedConnectionOwner {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

export type PinnedConnectionOwnerFactory = (
  pinned: PinnedAddress,
) => Promise<PinnedConnectionOwner>;
