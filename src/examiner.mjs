import {randomUUID} from 'node:crypto';
import {callGateway, readConfig} from './gateway.mjs';
import {hash} from './parsers.mjs';
import {exportReport} from './reports.mjs';

export const examinerTable = 'patents-public-data.uspto_oce_pair.application_data';
export const examinerSourceUrl = 'https://www.uspto.gov/ip-policy/economic-research/research-datasets/patent-examination-research-dataset-public-pair';
export const examinerHostUrl = 'https://console.cloud.google.com/bigquery?p=patents-public-data&d=uspto_oce_pair&t=application_data&page=table';
export const examinerContractVersion = 1;
const examinerCacheKind = 'examiner-trend';
export const patexReleaseSizing = Object.freeze({release:'2022',sourceSnapshot:'June 2023',applicationDataCsv:'887 MB',completeCsvRelease:'12.1 GB',source:examinerSourceUrl});

const queryText = `
WITH raw AS (
  SELECT
    application_number,
    examiner_name_last,
    examiner_name_first,
    examiner_name_middle,
    examiner_id,
    examiner_art_unit,
    disposal_type,
    COALESCE(SAFE.PARSE_DATE('%Y-%m-%d', filing_date), SAFE.PARSE_DATE('%Y%m%d', filing_date), SAFE.PARSE_DATE('%m/%d/%Y', filing_date)) AS filing_date_parsed,
    COALESCE(SAFE.PARSE_DATE('%Y-%m-%d', patent_issue_date), SAFE.PARSE_DATE('%Y%m%d', patent_issue_date), SAFE.PARSE_DATE('%m/%d/%Y', patent_issue_date)) AS patent_issue_date_parsed,
    COALESCE(SAFE.PARSE_DATE('%Y-%m-%d', abandon_date), SAFE.PARSE_DATE('%Y%m%d', abandon_date), SAFE.PARSE_DATE('%m/%d/%Y', abandon_date)) AS abandon_date_parsed
  FROM \`patents-public-data.uspto_oce_pair.application_data\`
  WHERE application_type = 'REGULAR'
    AND invention_subject_matter = 'UTL'
),
eligible AS (
  SELECT
    * EXCEPT(filing_date_parsed, patent_issue_date_parsed, abandon_date_parsed),
    IF(filing_date_parsed BETWEEN DATE '1900-01-01' AND @data_cutoff, filing_date_parsed, NULL) AS filing_date,
    IF(patent_issue_date_parsed BETWEEN DATE '1900-01-01' AND @data_cutoff, patent_issue_date_parsed, NULL) AS patent_issue_date,
    IF(abandon_date_parsed BETWEEN DATE '1900-01-01' AND @data_cutoff, abandon_date_parsed, NULL) AS abandon_date,
    COUNTIF(filing_date_parsed IS NOT NULL AND NOT (filing_date_parsed BETWEEN DATE '1900-01-01' AND @data_cutoff)) OVER () AS invalid_filing_dates,
    COUNTIF(patent_issue_date_parsed IS NOT NULL AND NOT (patent_issue_date_parsed BETWEEN DATE '1900-01-01' AND @data_cutoff)) OVER () AS invalid_issue_dates,
    COUNTIF(abandon_date_parsed IS NOT NULL AND NOT (abandon_date_parsed BETWEEN DATE '1900-01-01' AND @data_cutoff)) OVER () AS invalid_abandon_dates
  FROM raw
),
bounds AS (
  SELECT
    MAX(filing_date) AS max_filing_date,
    MAX(COALESCE(patent_issue_date, abandon_date)) AS max_disposal_date,
    MAX(invalid_filing_dates) AS invalid_filing_dates,
    MAX(invalid_issue_dates) AS invalid_issue_dates,
    MAX(invalid_abandon_dates) AS invalid_abandon_dates
  FROM eligible
),
scoped AS (
  SELECT
    application_number,
    disposal_type,
    CASE
      WHEN disposal_type = 'ISS' THEN EXTRACT(YEAR FROM patent_issue_date)
      WHEN disposal_type = 'ABN' THEN EXTRACT(YEAR FROM abandon_date)
    END AS disposal_year
  FROM eligible
  WHERE disposal_type IN ('ISS', 'ABN')
    AND (
      (@scope_type = 'examiner' AND UPPER(TRIM(REGEXP_REPLACE(CONCAT(COALESCE(examiner_name_last, ''), ', ', COALESCE(examiner_name_first, ''), ' ', COALESCE(examiner_name_middle, '')), r'\\s+', ' '))) = @scope_value)
      OR (@scope_type = 'art-unit' AND TRIM(examiner_art_unit) = @scope_value)
    )
),
yearly AS (
  SELECT
    disposal_year AS year,
    COUNT(DISTINCT IF(disposal_type = 'ISS', application_number, NULL)) AS issued,
    COUNT(DISTINCT IF(disposal_type = 'ABN', application_number, NULL)) AS abandoned
  FROM scoped
  WHERE disposal_year BETWEEN @from_year AND @to_year
  GROUP BY year
)
SELECT
  year,
  COALESCE(issued, 0) AS issued,
  COALESCE(abandoned, 0) AS abandoned,
  bounds.max_filing_date,
  bounds.max_disposal_date,
  bounds.invalid_filing_dates,
  bounds.invalid_issue_dates,
  bounds.invalid_abandon_dates
FROM UNNEST(GENERATE_ARRAY(@from_year, @to_year)) AS year
CROSS JOIN bounds
LEFT JOIN yearly USING (year)
ORDER BY year`;

function exactBytes(value, label) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^(0|[1-9]\d*)$/.test(text) || BigInt(text) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('BigQuery returned an invalid ' + label);
  return text;
}

function configuredBytes(value, label) {
  const text = exactBytes(value, label);
  if (text === '0') throw new Error(label + ' must be positive');
  return text;
}

function isoFromMillis(value, label) {
  const text = exactBytes(value, label);
  const date = new Date(Number(text));
  if (Number.isNaN(date.valueOf())) throw new Error('BigQuery returned invalid ' + label);
  return date.toISOString();
}

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z'))) throw new Error('BigQuery returned invalid ' + label);
  return value;
}

export function normalizeExaminerInput(input) {
  const scope = input?.scope;
  if (!['examiner', 'art-unit'].includes(scope)) throw new Error('Scope must be examiner or art-unit');
  const from = Number(input.from), to = Number(input.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1900 || to > new Date().getUTCFullYear() + 1 || from > to || to - from > 30) throw new Error('Year range must contain at most 31 years');
  let value;
  if (scope === 'examiner') {
    value = String(input.examiner ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
    if (value.length < 3 || value.length > 120 || !/^[\p{L}\p{N} .,'’-]+$/u.test(value)) throw new Error('Supply the exact PatEx examiner name');
  } else {
    value = String(input.artUnit ?? '').trim();
    if (!/^\d{4}$/.test(value)) throw new Error('Art unit must contain four digits');
  }
  return {scope, value, from, to};
}

export async function lookupExaminer(input, {hub}) {
  if (!hub?.query) throw new Error('Examiner lookup requires the USPTO ODP connector');
  const name = String(input?.name ?? '').trim().replace(/\s+/g, ' ');
  const limit = Number(input?.limit ?? 25);
  if (name.length < 2 || name.length > 80 || !/^[\p{L}\p{N} .,'’-]+$/u.test(name)) throw new Error('Supply an examiner name fragment without query operators');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Examiner lookup limit must be 1–50');
  const escaped = name.replace(/[“”]/g, '').replace(/"/g, '');
  const result = await hub.query('odp', `applicationMetaData.examinerNameText:"${escaped}"`, {limit});
  const candidates = new Map();
  for (const record of result.records) {
    const metadata = record.metadata?.applicationMetaData ?? {};
    if (typeof metadata.examinerNameText !== 'string' || !metadata.examinerNameText.trim()) continue;
    const examinerName = metadata.examinerNameText.trim().toUpperCase();
    const artUnit = typeof metadata.groupArtUnitNumber === 'string' ? metadata.groupArtUnitNumber : null;
    const key = examinerName + '|' + (artUnit ?? '');
    const current = candidates.get(key) ?? {examinerName, artUnit, recordsOnReturnedPage: 0, sampleApplication: record.metadata.applicationNumberText ?? null, sampleStatus: metadata.applicationStatusDescriptionText ?? null, latestFilingDateOnReturnedPage: null};
    current.recordsOnReturnedPage += 1;
    if (typeof metadata.filingDate === 'string' && (!current.latestFilingDateOnReturnedPage || metadata.filingDate > current.latestFilingDateOnReturnedPage)) current.latestFilingDateOnReturnedPage = metadata.filingDate;
    candidates.set(key, current);
  }
  return {source: 'odp', query: result.query, retrievedAt: result.created, providerTotal: result.providerTotal, returned: result.returned, nextCursor: result.nextCursor, candidates: [...candidates.values()].sort((a, b) => b.recordsOnReturnedPage - a.recordsOnReturnedPage || a.examinerName.localeCompare(b.examinerName)), coverage: 'One bounded USPTO Patent File Wrapper response page. Candidate page counts are not examiner caseload totals.', warning: 'Confirm the exact examiner name and art unit. Names are not stable unique identifiers, the current ODP assignment can differ from historical PatEx assignment, and multiple people can share name fragments.'};
}

export function buildExaminerPlan(input) {
  const parameters = normalizeExaminerInput(input);
  return {
    table: examinerTable,
    parameters,
    countingUnit: 'distinct regular nonprovisional utility application numbers with an ISS or ABN disposal',
    request: {
      configuration: {
        dryRun: true,
        query: {
          query: queryText,
          useLegacySql: false,
          parameterMode: 'NAMED',
          queryParameters: [
            {name: 'scope_type', parameterType: {type: 'STRING'}, parameterValue: {value: parameters.scope}},
            {name: 'scope_value', parameterType: {type: 'STRING'}, parameterValue: {value: parameters.value}},
            {name: 'from_year', parameterType: {type: 'INT64'}, parameterValue: {value: String(parameters.from)}},
            {name: 'to_year', parameterType: {type: 'INT64'}, parameterValue: {value: String(parameters.to)}},
            {name: 'data_cutoff', parameterType: {type: 'DATE'}, parameterValue: {value: new Date().toISOString().slice(0, 10)}},
          ],
        },
      },
    },
  };
}

export function examinerCacheKey(input) {
  const parameters = normalizeExaminerInput(input);
  return hash(JSON.stringify({contract:'patent-research/examiner-trend',version:examinerContractVersion,table:examinerTable,parameters}));
}

export function examinerSourceStatus({config = readConfig(), store} = {}) {
  const cache = store?.queryCacheStatus ? store.queryCacheStatus(examinerCacheKind) : {kind:examinerCacheKind,entries:0,firstCreatedAt:null,lastUpdatedAt:null,integrity:'unavailable'};
  return {
    contract: {name:'patent-research/examiner-analytics',version:examinerContractVersion,interfaces:['MCP','CLI','n8n']},
    strategy: 'hosted query on demand with a validated local aggregate cache',
    downloadRequired: false,
    hosted: {provider:'Google BigQuery',table:examinerTable,executionEnabled:config.googleBigQueryExecutionEnabled===true,billingMode:config.googleBigQueryBillingMode||null,queryCache:true},
    localPersistence: {...cache,contents:'Only validated aggregate results and provenance; no application-level records or provider credentials.'},
    optionalOfficialBulkSnapshot: {...patexReleaseSizing,installed:false,purpose:'Optional future offline coverage or a newer historical snapshot; it is not required for normal examiner calls.'},
    identityLookup: {provider:'USPTO Patent File Wrapper API',mode:'live bounded lookup'},
  };
}

export function buildExaminerExecutionRequest(plan, maximumBytesBilled) {
  if (!plan?.request?.configuration?.query || plan.request.configuration.dryRun !== true) throw new Error('Examiner execution requires the fixed dry-run plan');
  if (typeof maximumBytesBilled !== 'string' || !/^[1-9]\d*$/.test(maximumBytesBilled)) throw new Error('Invalid BigQuery execution ceiling');
  return {...plan.request.configuration.query, dryRun: false, useQueryCache: true, maxResults: 31, timeoutMs: 120000, jobTimeoutMs: '180000', maximumBytesBilled, labels: {application: 'patent_research', operation: 'patex_examiner_outcomes'}};
}

function validateTableMetadata(metadata) {
  if (metadata?.projectId !== 'patents-public-data' || metadata?.datasetId !== 'uspto_oce_pair' || metadata?.tableId !== 'application_data') throw new Error('PatEx table identity was not verified');
  const required = new Map([
    ['application_number', 'STRING'], ['filing_date', 'STRING'], ['invention_subject_matter', 'STRING'], ['application_type', 'STRING'],
    ['examiner_name_last', 'STRING'], ['examiner_name_first', 'STRING'], ['examiner_name_middle', 'STRING'], ['examiner_id', 'STRING'], ['examiner_art_unit', 'STRING'],
    ['patent_issue_date', 'STRING'], ['abandon_date', 'STRING'], ['disposal_type', 'STRING'],
  ]);
  if (!Array.isArray(metadata.schema)) throw new Error('PatEx table schema was not returned');
  for (const [name, type] of required) if (!metadata.schema.some(field => field?.name === name && field?.type === type)) throw new Error(`PatEx table schema is missing ${name}:${type}`);
  return {
    lastModifiedAt: isoFromMillis(metadata.lastModifiedTime, 'table update time'),
    numRows: exactBytes(metadata.numRows, 'table row count'),
    numBytes: exactBytes(metadata.numBytes, 'table byte count'),
  };
}

export function validateExaminerEstimate(response, {plan, projectId}) {
  if (!response || response.status !== 200 || response.error || response.errors?.length) throw new Error('BigQuery examiner dry run failed');
  if (response.dryRun !== true || response.executedDataQuery !== false) throw new Error('BigQuery response did not prove dry-run-only execution');
  if (response.jobReference?.projectId !== projectId) throw new Error('BigQuery examiner dry run used an unexpected project');
  const processed = exactBytes(response.statistics?.totalBytesProcessed, 'processed-byte estimate');
  const billed = exactBytes(response.statistics?.query?.totalBytesBilled, 'billed-byte value');
  if (billed !== '0') throw new Error('BigQuery examiner dry run reported billed bytes');
  return {source: 'google-bigquery', mode: 'patex-examiner-dry-run', projectId, table: plan.table, parameters: plan.parameters, countingUnit: plan.countingUnit, status: response.status, dryRun: true, executedDataQuery: false, totalBytesProcessed: processed, estimatedGiB: Number(processed) / (1024 ** 3), totalBytesBilled: '0', estimateAccuracy: response.statistics?.query?.totalBytesProcessedAccuracy ?? null, warning: 'Cost and schema preflight only. No examiner outcome rows were produced.'};
}

export async function estimateExaminer(input, {config = readConfig(), call = callGateway} = {}) {
  if (config.googleBigQueryDryRunEnabled !== true) throw new Error('BigQuery dry-run gateway is not enabled');
  if (typeof config.googleBigQueryProjectId !== 'string' || !config.googleBigQueryProjectId) throw new Error('BigQuery project is not configured');
  const plan = buildExaminerPlan(input);
  const response = await call('examiner-bigquery', plan.parameters, {config, maxBytes: 200000});
  return validateExaminerEstimate(response, {plan, projectId: config.googleBigQueryProjectId});
}

export function validateExaminerTrend(response, {plan, projectId, maximumBytesBilled}) {
  if (!response || response.status !== 200 || response.error || response.errors?.length) throw new Error('BigQuery examiner outcome query failed');
  if (response.dryRun !== false || response.executedDataQuery !== true || response.jobComplete !== true) throw new Error('BigQuery did not return a completed examiner query');
  if (response.jobReference?.projectId !== projectId || response.maximumBytesBilled !== maximumBytesBilled) throw new Error('BigQuery examiner query did not preserve the configured project and byte ceiling');
  const expected = [['year', 'INTEGER'], ['issued', 'INTEGER'], ['abandoned', 'INTEGER'], ['max_filing_date', 'DATE'], ['max_disposal_date', 'DATE'], ['invalid_filing_dates', 'INTEGER'], ['invalid_issue_dates', 'INTEGER'], ['invalid_abandon_dates', 'INTEGER']];
  const fields = response.schema?.fields;
  if (!Array.isArray(fields) || fields.length !== expected.length || expected.some(([name, type], index) => fields[index]?.name !== name || fields[index]?.type !== type)) throw new Error('BigQuery examiner result schema changed');
  const totalRows = Number(exactBytes(response.totalRows, 'result-row count'));
  if (totalRows !== plan.parameters.to - plan.parameters.from + 1 || !Array.isArray(response.rows) || response.rows.length !== totalRows) throw new Error('BigQuery examiner result was truncated or incomplete');
  const seen = new Set(), series = [];
  let maxFilingDate = null, maxDisposalDate = null, invalidFilingDates = null, invalidIssueDates = null, invalidAbandonDates = null;
  for (const row of response.rows) {
    if (!Array.isArray(row?.f) || row.f.length !== expected.length) throw new Error('BigQuery examiner row shape changed');
    const year = Number(exactBytes(row.f[0]?.v, 'year'));
    const issued = Number(exactBytes(row.f[1]?.v, 'issued count'));
    const abandoned = Number(exactBytes(row.f[2]?.v, 'abandoned count'));
    if (!Number.isInteger(year) || year < plan.parameters.from || year > plan.parameters.to || seen.has(year)) throw new Error('BigQuery returned an invalid or duplicate examiner year');
    seen.add(year);
    const filing = validDate(row.f[3]?.v, 'maximum filing date'), disposal = validDate(row.f[4]?.v, 'maximum disposal date');
    if ((maxFilingDate && filing !== maxFilingDate) || (maxDisposalDate && disposal !== maxDisposalDate)) throw new Error('BigQuery returned inconsistent PatEx data bounds');
    maxFilingDate = filing; maxDisposalDate = disposal;
    const invalidFiling = exactBytes(row.f[5]?.v, 'invalid filing-date count'), invalidIssue = exactBytes(row.f[6]?.v, 'invalid issue-date count'), invalidAbandon = exactBytes(row.f[7]?.v, 'invalid abandonment-date count');
    if ((invalidFilingDates !== null && invalidFiling !== invalidFilingDates) || (invalidIssueDates !== null && invalidIssue !== invalidIssueDates) || (invalidAbandonDates !== null && invalidAbandon !== invalidAbandonDates)) throw new Error('BigQuery returned inconsistent PatEx date-quality counts');
    invalidFilingDates = invalidFiling; invalidIssueDates = invalidIssue; invalidAbandonDates = invalidAbandon;
    const disposed = issued + abandoned;
    series.push({year, issued, abandoned, disposed, issueSharePercent: disposed ? Math.round(issued / disposed * 10000) / 100 : null, count: disposed, yoyPercent: null});
  }
  series.sort((a, b) => a.year - b.year);
  const processed = exactBytes(response.totalBytesProcessed, 'processed-byte total'), billed = exactBytes(response.totalBytesBilled, 'billed-byte total');
  if (BigInt(processed) > BigInt(maximumBytesBilled) || BigInt(billed) > BigInt(maximumBytesBilled)) throw new Error('BigQuery exceeded the configured examiner byte ceiling');
  if (response.tableMetadataStatus !== 200) throw new Error('PatEx table metadata was not verified');
  const tableMetadata = validateTableMetadata(response.tableMetadata);
  const dataCutoff = tableMetadata.lastModifiedAt.slice(0, 10);
  if (maxFilingDate > dataCutoff || maxDisposalDate > dataCutoff) throw new Error('PatEx data bounds exceeded the verified table snapshot date');
  return {
    source: 'google-bigquery', mode: 'patex-examiner-observed-outcomes', projectId, table: plan.table, parameters: plan.parameters,
    countingUnit: plan.countingUnit, status: response.status, dryRun: false, executedDataQuery: true, jobComplete: true, jobReference: response.jobReference,
    totalBytesProcessed: processed, totalBytesBilled: billed, cacheHit: response.cacheHit === true, maximumBytesBilled, series,
    dataBounds: {maxFilingDate, maxDisposalDate, dataCutoff}, dataQuality: {invalidFilingDates, invalidIssueDates, invalidAbandonDates}, tableLastModifiedAt: tableMetadata.lastModifiedAt, tableMetadata: {numRows: tableMetadata.numRows, numBytes: tableMetadata.numBytes},
    coverage: 'Distinct regular nonprovisional utility application numbers in Google’s hosted copy of the USPTO PatEx application_data table, grouped by issue or abandonment year. Only PatEx disposal_type ISS and ABN are included.',
    warnings: [
      'This issued share is not the USPTO allowance rate. It excludes pending applications and does not count RCE abandonments as separate disposals.',
      'PatEx contains publicly viewable applications. Applications that never became public are outside this dataset, so examiner comparisons can be selected by publication rules and prosecution history.',
      'The examiner and art unit are snapshot fields. For disposed applications they reflect assignment at disposal. This tool matches the historical mirror’s separate examiner-name fields; exact-name collisions can combine people, and art-unit assignments can change.',
      'Google’s hosted PatEx table is an older mirror and may lag the newest USPTO bulk release. Use the returned table timestamp and maximum data dates; recent cohorts are censored and should not be treated as mature outcomes.',
      'Date strings outside 1900 through the verified table-modification date are excluded. The report records their dataset-wide counts so sentinel or malformed future dates cannot distort date bounds or yearly outcomes.',
      'The local monthly ledger covers BigQuery work initiated through this research tool only. Zero-cost operation depends on the isolated project remaining a no-billing sandbox.',
    ],
  };
}

export async function queryExaminerTrend(input, {config = readConfig(), call = callGateway, store, estimate = estimateExaminer} = {}) {
  if (!store?.reserveBigQuery || !store?.completeBigQuery) throw new Error('Examiner execution requires the local BigQuery usage ledger');
  const plan = buildExaminerPlan(input), cacheKey = examinerCacheKey(input);
  const cached = store.getQueryCache ? store.getQueryCache(examinerCacheKind, cacheKey) : null;
  const cachedFallback = (error, providerAttempted = true) => {
    if (!cached) throw error;
    const servedAt = new Date().toISOString();
    return {...cached.value,
      delivery:{mode:'local-validated-aggregate-cache',servedAt,cachedAt:cached.updatedAt,payloadSha256:cached.payloadSha256,providerAttempted,providerError:error.message},
      warnings:[`This request used the locally persisted aggregate because the hosted provider call did not complete: ${error.message}`,...cached.value.warnings],
    };
  };
  if (config.googleBigQueryExecutionEnabled !== true || !['sandbox-no-billing', 'billing-enabled-capped'].includes(config.googleBigQueryBillingMode)) return cachedFallback(new Error('Examiner execution requires googleBigQueryExecutionEnabled and the confirmed no-billing BigQuery sandbox (or an acknowledged capped billing mode)'),false);
  const projectId = config.googleBigQueryProjectId;
  const maximumBytesBilled = configuredBytes(config.googleBigQueryPerQueryMaxBytes, 'BigQuery per-query byte ceiling');
  const monthlyLimit = configuredBytes(config.googleBigQueryMonthlyTrackedMaxBytes, 'BigQuery monthly tracked limit');
  let preflight, reservationId, budget;
  try {
    preflight = await estimate(input, {config, call});
    if (BigInt(preflight.totalBytesProcessed) > BigInt(maximumBytesBilled)) throw new Error('BigQuery examiner dry-run estimate exceeds the per-query byte ceiling');
    // Track the reservation only after it exists, so a refused reservation reports its own error.
    const pendingId = randomUUID(), month = new Date().toISOString().slice(0, 7);
    budget = store.reserveBigQuery({id: pendingId, month, estimatedBytes: preflight.totalBytesProcessed, monthlyLimit, parameters: {operation: 'patex-examiner-outcomes', ...plan.parameters}}); reservationId = pendingId;
    const response = await call('examiner-bigquery-query', plan.parameters, {config, maxBytes: 500000});
    const result = validateExaminerTrend(response, {plan, projectId, maximumBytesBilled});
    const usage = BigInt(result.totalBytesProcessed) > BigInt(result.totalBytesBilled) ? result.totalBytesProcessed : result.totalBytesBilled;
    const ledger = store.completeBigQuery(reservationId, {status: 'complete', usageBytes: usage, jobReference: result.jobReference, cacheHit: result.cacheHit});
    reservationId = null;
    const servedAt = new Date().toISOString();
    const trend = {...result, preflight: {totalBytesProcessed: preflight.totalBytesProcessed, estimateAccuracy: preflight.estimateAccuracy}, budget: {...budget, ...ledger},delivery:{mode:'hosted-query',servedAt,providerAttempted:true}};
    if (store.saveQueryCache) {
      try {
        const saved = store.saveQueryCache(examinerCacheKind, cacheKey, trend);
        trend.delivery = {...trend.delivery,persistedAt:saved.updatedAt,payloadSha256:saved.payloadSha256};
      } catch (error) {
        trend.delivery = {...trend.delivery,persistenceError:error.message};
        trend.warnings = [`The hosted query succeeded, but its local aggregate could not be persisted: ${error.message}`,...trend.warnings];
      }
    }
    return trend;
  } catch (error) {
    if (reservationId) store.completeBigQuery(reservationId, {status: 'unknown', usageBytes: preflight.totalBytesProcessed, error: error.message});
    return cachedFallback(error);
  }
}

export function examinerReportInput(trend) {
  const snapshotDate = trend.dataBounds.dataCutoff;
  const scopeLabel = trend.parameters.scope === 'examiner' ? `Examiner ${trend.parameters.value}` : `Art unit ${trend.parameters.value}`;
  const dataset = {source: trend.table, sourceUrl: examinerHostUrl, sourceDocumentation: examinerSourceUrl, snapshotDate, retrievedAt: trend.delivery?.servedAt||new Date().toISOString(), coverage: trend.coverage, parameters: trend.parameters, dataBounds: trend.dataBounds, dataQuality: trend.dataQuality, tableLastModifiedAt: trend.tableLastModifiedAt, aggregateRows: trend.series, delivery:trend.delivery||null, execution: {jobReference: trend.jobReference, totalBytesProcessed: trend.totalBytesProcessed, totalBytesBilled: trend.totalBytesBilled, cacheHit: trend.cacheHit, maximumBytesBilled: trend.maximumBytesBilled, preflight: trend.preflight, trackedMonthlyBudget: trend.budget}};
  const analysis = {title: `${scopeLabel}: PatEx observed outcomes by disposal year`, source: trend.table, sourceUrl: examinerHostUrl, sourceDocumentation: examinerSourceUrl, snapshotDate, coverage: trend.coverage, datasetSha256: hash(JSON.stringify(dataset)), definition: {scope: trend.parameters.scope, value: trend.parameters.value, applicationType: 'REGULAR', inventionSubjectMatter: 'UTL', disposition: 'ISS or ABN', dateBasis: 'disposal', unit: 'application number', from: trend.parameters.from, to: trend.parameters.to}, series: trend.series, duplicatesRemoved: 0, excludedMissing: 0, warnings: trend.warnings, methodVersion: 1};
  return {dataset, analysis};
}

export async function exportExaminerReport(trend, input = {}) {
  const {dataset, analysis} = examinerReportInput(trend);
  const totalIssued = trend.series.reduce((sum, row) => sum + row.issued, 0), totalAbandoned = trend.series.reduce((sum, row) => sum + row.abandoned, 0), totalDisposed = totalIssued + totalAbandoned;
  const scopeLabel = trend.parameters.scope === 'examiner' ? `Examiner ${trend.parameters.value}` : `Art unit ${trend.parameters.value}`;
  const executionFact = trend.delivery?.mode==='local-validated-aggregate-cache' ? `The tool served its locally persisted, SHA-256-checked aggregate saved at ${trend.delivery.cachedAt}; no hosted data query completed for this request. The aggregate remains tied to the ${trend.tableLastModifiedAt} hosted-table snapshot.` : trend.cacheHit ? `BigQuery served the result from cache and reported zero additional processed and billed bytes; the dry-run estimate was ${trend.preflight.totalBytesProcessed} bytes.` : `BigQuery processed ${trend.totalBytesProcessed} bytes and reported ${trend.totalBytesBilled} billed bytes under the ${trend.maximumBytesBilled}-byte ceiling.`;
  const ledgerFact = trend.delivery?.mode==='local-validated-aggregate-cache' ? `The cached aggregate records a ${trend.budget.trackedMonth} tool-ledger value of ${trend.budget.trackedBytesAfter} of ${trend.budget.monthlyLimitBytes} bytes at its original acquisition; this is not a fresh usage reading.` : `The tool's conservative ${trend.budget.trackedMonth} ledger stands at ${trend.budget.trackedBytesAfter} of ${trend.budget.monthlyLimitBytes} bytes.`;
  const files = await exportReport({title: input.title || analysis.title, question: `What issued and abandoned outcomes does the hosted PatEx snapshot report for ${scopeLabel} from ${trend.parameters.from} through ${trend.parameters.to}?`, facts: [`The query found ${totalIssued.toLocaleString('en-US')} issued and ${totalAbandoned.toLocaleString('en-US')} abandoned application outcomes, ${totalDisposed.toLocaleString('en-US')} total, under the stated PatEx filters.`, executionFact, `The hosted table reports a maximum filing date of ${trend.dataBounds.maxFilingDate}, maximum disposal date of ${trend.dataBounds.maxDisposalDate}, and table modification time of ${trend.tableLastModifiedAt}.`, `The date-quality filter excluded ${trend.dataQuality.invalidFilingDates} filing, ${trend.dataQuality.invalidIssueDates} issue, and ${trend.dataQuality.invalidAbandonDates} abandonment date values outside 1900 through the verified ${trend.dataBounds.dataCutoff} table snapshot across the eligible table population.`, ledgerFact], inferences: [], openQuestions: ['Compare the exact examiner identity against live ODP records before using this historical snapshot in a matter.', 'Use the newest USPTO PatEx bulk release if post-snapshot outcomes are material.'], analysis, dataset});
  return {trend, analysis, files};
}

export async function queryExaminerReport(input, options = {}) {
  return exportExaminerReport(await queryExaminerTrend(input, options), input);
}
