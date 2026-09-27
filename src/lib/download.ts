/**
 * Saving a blob to disk.
 *
 * The one non-obvious rule here is the deferred revoke. A synchronous
 * `revokeObjectURL` cancels the download in Chromium, because the navigation the
 * click schedules has not read the object URL yet. The revoke therefore lands on the
 * next macrotask, which is late enough for the browser to have taken the URL and
 * early enough that the blob is not retained for the life of the page.
 */

/**
 * Triggers a browser download of `blob` under `fileName`.
 *
 * `fileName` is passed to the `download` property verbatim: no sanitizing, no
 * re-encoding, so a Chinese or emoji filename survives byte-for-byte and the
 * browser is left to decide its own fallback. The anchor is attached to `doc.body`
 * because Chromium ignores clicks on detached anchors, and is removed again as soon
 * as the click has been dispatched.
 *
 * @param doc Document to attach the anchor to; defaults to the global `document`.
 */
export function downloadBlob(blob: Blob, fileName: string, doc: Document = document): void {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = doc.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  doc.body.appendChild(anchor)
  anchor.click()
  doc.body.removeChild(anchor)
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl)
  }, 0)
}
