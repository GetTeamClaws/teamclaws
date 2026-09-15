export function archiveListingEntries(listing) {
  if (typeof listing !== "string") {
    throw new TypeError("archive listing must be text");
  }
  return listing.split(/\r?\n/u);
}
