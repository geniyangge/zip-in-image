// Global test setup.
//
// Runs for BOTH environments, so everything below the `typeof window` guard must
// stay a complete no-op outside jsdom. Node 18 ships a working core
// `URL.createObjectURL`; jsdom 24 does not implement it and throws
// "Not implemented". Only the jsdom branch installs anything, and even there the
// probe below refuses to clobber an implementation that already works.

export interface MockObjectUrlRecord {
  /** Fake URLs handed out so far, in creation order. */
  readonly created: string[]
  /** Fake URLs passed to `revokeObjectURL`, in revocation order. */
  readonly revoked: string[]
  /** Clears both ledgers and restarts the counter at 1. */
  reset(): void
}

const created: string[] = []
const revoked: string[] = []
let issued = 0

export const objectUrlRecord: MockObjectUrlRecord = {
  created,
  revoked,
  reset() {
    issued = 0
    created.length = 0
    revoked.length = 0
  },
}

declare global {
  // Published on `globalThis` because setup files and spec files are separate
  // module graphs; the record has to survive that boundary. `var` is the only
  // way to declare a typed global value.
  var objectUrlRecord: MockObjectUrlRecord
}

/** True when the ambient `URL` already implements the object-URL API. */
function objectUrlApiWorks(): boolean {
  try {
    const probe = URL.createObjectURL(new Blob(['probe']))
    URL.revokeObjectURL(probe)
    return true
  } catch {
    return false
  }
}

function installObjectUrlMock(): void {
  URL.createObjectURL = (): string => {
    issued += 1
    const url = `blob:mock/${issued}`
    created.push(url)
    return url
  }
  URL.revokeObjectURL = (url: string): void => {
    revoked.push(url)
  }
}

if (typeof window !== 'undefined') {
  globalThis.objectUrlRecord = objectUrlRecord
  if (!objectUrlApiWorks()) installObjectUrlMock()
}
