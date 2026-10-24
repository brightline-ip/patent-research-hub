// Public ODP continuity only. No credentials, ownership inference, or EPO-family claim.
// Schema: https://data.uspto.gov/swagger/index.html (PatentDataResponse,
// ParentContinuityData, ChildContinuityData), inspected 2026-09-07.
const application = x => typeof x === 'string' && /^\d{8}$/.test(x);
const clean = (x, n = 200) => typeof x === 'string' ? x.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n) : null;
export function parsePublicContinuity(applicationNumber, result) {
  if (!application(applicationNumber) || !Array.isArray(result?.records)
    || result.records.length > 1 || result.nextCursor != null
    || result.providerTotal !== result.records.length || !/^[a-f0-9]{64}$/.test(result.snapshotId ?? ''))
    throw Error('Exact public application lookup was incomplete or ambiguous');
  const observation = {application_number: applicationNumber, snapshot_id: result.snapshotId,
    status: result.records.length ? 'PUBLIC_RECORD' : 'PUBLIC_RECORD_NOT_FOUND',
    relations: [], excluded: [], issues: [],
    source_url: 'https://data.uspto.gov/patent-file-wrapper/search/details/' + applicationNumber};
  if (!result.records.length) return observation;
  const data = result.records[0]?.metadata;
  if (data?.applicationNumberText !== applicationNumber) throw Error('Public application identity mismatch');
  for (const [bag, direction, anchor, target] of [
    ['parentContinuityBag', 'parent', 'childApplicationNumberText', 'parentApplicationNumberText'],
    ['childContinuityBag', 'child', 'parentApplicationNumberText', 'childApplicationNumberText']
  ]) {
    // The official schema omits fields without data. Null is not that contract.
    const rows = data[bag] === undefined ? [] : data[bag];
    if (!Array.isArray(rows) || rows.length > 2000) throw Error('Unrecognized or oversized continuity bag');
    rows.forEach((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || row[anchor] !== applicationNumber) {
        observation.issues.push({bag, row: index, reason: 'RELATION_ANCHOR_MISMATCH'}); return;
      }
      if (!application(row[target])) {
        observation.excluded.push({bag, row: index, identifier: clean(row[target], 80), reason: 'NOT_EXACT_US_APPLICATION'}); return;
      }
      if (row[target] === applicationNumber) {
        observation.issues.push({bag, row: index, reason: 'SELF_RELATION'}); return;
      }
      observation.relations.push({direction, related_application: row[target],
        parent: direction === 'parent' ? row[target] : applicationNumber,
        child: direction === 'child' ? row[target] : applicationNumber,
        type_code: clean(row.claimParentageTypeCode, 30),
        description: clean(row.claimParentageTypeCodeDescriptionText), bag, row: index});
    });
  }
  return observation;
}
export async function lookupPublicContinuity(applicationNumber, {client} = {}) {
  if (!application(applicationNumber) || typeof client?.query !== 'function') throw Error('Exact US application and shared query client required');
  const result = await client.query('odp', 'applicationNumberText:"' + applicationNumber + '"', {limit: 2});
  return parsePublicContinuity(applicationNumber, result);
}
