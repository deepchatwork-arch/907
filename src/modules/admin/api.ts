import { supabase } from '@/lib/supabase'
import { toApiError } from '@/lib/errors'
import { fetchAllPages, chunk } from '@/lib/paginate'
import { resolveMime, extForMime, validateReceipt } from '@/lib/files'
import { currentDict } from '@/i18n'
import type {
  WarehouseStockRow,
  ReportStockMoveRow,
  ToOrderRow,
  ApartmentGapRow,
  EventRow,
  StockMoveRow,
  NormRuleRow,
  CleaningEventRow,
  IssueMissingResult,
  Apartment,
  Building,
  Staff,
  Contact,
  Incident,
  Category,
  Item,
  ItemKind,
  BaseUnit,
  Supplier,
  DocumentRow,
  DocumentWithSupplier,
  AttachmentRow,
  PostDocumentResult,
  ReverseCleaningResult,
  RecalculateCleaningResult,
  ApproveIncidentResult,
  NormalizedShortageEvent,
} from '@/lib/database.types'

// ---- Queries ----

export async function fetchToOrder(): Promise<ToOrderRow[]> {
  const { data, error, status } = await supabase
    .from('to_order')
    .select('item_id,name,category,base_unit,pack_size,pack_label,qty,min_stock,shortage')
    .order('shortage', { ascending: false })
  if (error) throw toApiError(error, status)
  return data ?? []
}

export async function fetchApartmentGaps(): Promise<ApartmentGapRow[]> {
  return fetchAllPages<ApartmentGapRow>((from, to) =>
    supabase
      .from('apartment_gap')
      .select('apartment_id,code,item_id,name,norm,actual,gap')
      .gt('gap', 0)
      .order('apartment_id')
      .order('item_id')
      .range(from, to),
  )
}

export async function fetchShortageEvents(): Promise<NormalizedShortageEvent[]> {
  const { data, error, status } = await supabase
    .from('events')
    .select('id,type,payload,created_at,processed_at')
    .in('type', ['shortage', 'inventory_shortage'])
    .is('processed_at', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(20)
  if (error) throw toApiError(error, status)
  return (data ?? []).map((ev) => normalizeShortageEvent(ev as unknown as EventRow))
}

function normalizeShortageEvent(ev: EventRow): NormalizedShortageEvent {
  const payload = ev.payload as {
    items?: Array<Record<string, unknown>>
  }
  const rawItems = payload?.items ?? []
  const items = rawItems.map((it) => ({
    name: String(it.item ?? it.name ?? '—'),
    qty: Number(it.balance ?? it.qty ?? 0),
    unit: '',
  }))
  return {
    id: ev.id,
    type: ev.type,
    created_at: ev.created_at,
    items,
  }
}

export async function ackEvents(ids: number[]): Promise<void> {
  const { error, status } = await supabase.rpc('events_ack', { p_ids: ids })
  if (error) throw toApiError(error, status)
}

export async function fetchWarehouseStock(): Promise<WarehouseStockRow[]> {
  return fetchAllPages<WarehouseStockRow>((from, to) =>
    supabase
      .from('warehouse_stock')
      .select('item_id,name,category,kind,base_unit,pack_size,pack_label,qty,min_stock,below_min')
      .order('name')
      .order('item_id')
      .range(from, to),
  )
}

export const fetchReportWarehouseStock = fetchWarehouseStock

export async function fetchReportStockMoves(fromISO: string, toISO: string): Promise<ReportStockMoveRow[]> {
  const rows = await fetchAllPages<StockMoveRow & { moved_at: string }>((from, to) =>
    supabase
      .from('stock_moves')
      .select('id,item_id,qty,unit_cost,source_type,apartment_id,moved_at')
      .gte('moved_at', fromISO)
      .lt('moved_at', toISO)
      .order('moved_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  )

  const itemIds = Array.from(new Set(rows.map((row) => row.item_id)))
  const apartmentIds = Array.from(new Set(rows.map((row) => row.apartment_id).filter((id): id is number => id !== null)))

  const itemsResult = itemIds.length
    ? await Promise.all(chunk(itemIds).map((batch) => supabase.from('items').select('id,name,category_id,pack_size,pack_label').in('id', batch)))
    : []
  const apartmentsResult = apartmentIds.length
    ? await Promise.all(chunk(apartmentIds).map((batch) => supabase.from('apartments').select('id,code').in('id', batch)))
    : []
  for (const r of itemsResult) if (r.error) throw toApiError(r.error, r.status)
  for (const r of apartmentsResult) if (r.error) throw toApiError(r.error, r.status)

  const allItems = itemsResult.flatMap((r) => r.data ?? [])
  const allApartments = apartmentsResult.flatMap((r) => r.data ?? [])

  const categoryIds = Array.from(new Set(allItems.map((item) => item.category_id)))
  const categoriesResult = categoryIds.length
    ? await Promise.all(chunk(categoryIds).map((batch) => supabase.from('categories').select('id,name').in('id', batch)))
    : []
  for (const r of categoriesResult) if (r.error) throw toApiError(r.error, r.status)
  const allCategories = categoriesResult.flatMap((r) => r.data ?? [])

  const itemMap = new Map(allItems.map((item) => [item.id, item]))
  const categoryMap = new Map(allCategories.map((category) => [category.id, category.name]))
  const apartmentMap = new Map(allApartments.map((apartment) => [apartment.id, apartment.code]))

  return rows.map((row) => {
    const item = itemMap.get(row.item_id)
    return {
      id: row.id,
      item_id: row.item_id,
      item_name: item?.name ?? '—',
      category: item ? categoryMap.get(item.category_id) ?? '—' : '—',
      pack_size: Number(item?.pack_size ?? 1),
      pack_label: item?.pack_label ?? '',
      qty: Number(row.qty),
      unit_cost: row.unit_cost == null ? null : Number(row.unit_cost),
      source_type: row.source_type,
      apartment_id: row.apartment_id,
      apartment_code: row.apartment_id == null ? null : apartmentMap.get(row.apartment_id) ?? '—',
      moved_at: row.moved_at,
    }
  })
}

export async function fetchStockMoves(itemId: number, offset = 0): Promise<StockMoveRow[]> {
  const { data, error, status } = await supabase
    .from('stock_moves')
    .select('id,item_id,from_loc,to_loc,qty,unit_cost,source_type,source_id,apartment_id,staff_id,note,moved_at,created_by')
    .eq('item_id', itemId)
    .order('moved_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + 49)
  if (error) throw toApiError(error, status)
  const rows = (data ?? []) as Array<StockMoveRow & { created_by: string | null }>
  const locationIds = Array.from(new Set(rows.flatMap((row) => [row.from_loc, row.to_loc])))
  const authorIds = Array.from(new Set(rows.map((row) => row.created_by).filter((id): id is string => id !== null)))

  const [locationsResults, profilesResults] = await Promise.all([
    locationIds.length ? Promise.all(chunk(locationIds).map((batch) => supabase.from('locations').select('id,name,type').in('id', batch))) : [],
    authorIds.length ? Promise.all(chunk(authorIds).map((batch) => supabase.from('profiles').select('id,full_name,login').in('id', batch))) : [],
  ])
  for (const r of locationsResults) if (r.error) throw toApiError(r.error, r.status)
  for (const r of profilesResults) if (r.error) throw toApiError(r.error, r.status)
  const allLocations = locationsResults.flatMap((r) => r.data ?? [])
  const allProfiles = profilesResults.flatMap((r) => r.data ?? [])

  const locationMap = new Map(allLocations.map((location) => [location.id, location]))
  const profileMap = new Map(allProfiles.map((profile) => [profile.id, profile.full_name || profile.login]))
  return rows.map(({ created_by: createdBy, ...row }) => ({
    ...row,
    from_location: locationMap.get(row.from_loc),
    to_location: locationMap.get(row.to_loc),
    author: createdBy ? profileMap.get(createdBy) ?? null : null,
  }))
}

export async function fetchApartmentsAdmin(): Promise<Apartment[]> {
  const { data, error, status } = await supabase
    .from('apartments')
    .select('id,building_id,number,code,type,status,created_at')
    .order('code')
  if (error) throw toApiError(error, status)
  return data ?? []
}

export async function fetchBuildings(): Promise<Building[]> {
  const { data, error, status } = await supabase
    .from('buildings')
    .select('id,name')
    .order('name')
  if (error) throw toApiError(error, status)
  return data ?? []
}

export async function fetchNormRules(apartmentId: number): Promise<NormRuleRow[]> {
  const { data, error, status } = await supabase
    .from('norm_rules')
    .select('id,norm_type,apt_type,apartment_id,item_id,qty,note')
    .eq('apartment_id', apartmentId)
    .order('norm_type')
    .order('item_id')
  if (error) throw toApiError(error, status)
  return data ?? []
}

export async function fetchTemplateNorms(aptType: string): Promise<NormRuleRow[]> {
  const { data, error, status } = await supabase
    .from('norm_rules')
    .select('id,norm_type,apt_type,apartment_id,item_id,qty,note')
    .eq('apt_type', aptType)
    .is('apartment_id', null)
    .order('norm_type')
    .order('item_id')
  if (error) throw toApiError(error, status)
  return data ?? []
}

export async function fetchCleaningEvents(apartmentId: number, limit = 200, offset = 0): Promise<CleaningEventRow[]> {
  const { data, error, status } = await supabase
    .from('cleaning_events')
    .select('id, apartment_id, cleaned_at, status, revision, note, lead_staff_id, reverse_reason, cleaning_event_staff(staff_id, staff(full_name))')
    .eq('apartment_id', apartmentId)
    .order('cleaned_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) throw toApiError(error, status)
  const rows = (data ?? []) as unknown as Array<{
    id: string
    apartment_id: number
    cleaned_at: string
    status: CleaningEventRow['status']
    revision: number
    note: string | null
    lead_staff_id: number | null
    reverse_reason: string | null
    cleaning_event_staff: Array<{
      staff_id: number
      staff: { full_name: string } | { full_name: string }[]
    }>
  }>
  return rows.map((r) => ({
    ...r,
    cleaning_event_staff: (r.cleaning_event_staff ?? []).map((e) => ({
      staff_id: e.staff_id,
      staff: Array.isArray(e.staff) ? e.staff[0] : e.staff,
    })),
  }))
}

export async function fetchAllStaff(): Promise<Staff[]> {
  return fetchAllPages<Staff>((from, to) =>
    supabase
      .from('staff')
      .select('id,full_name,role,phone,active')
      .order('id')
      .range(from, to),
  )
}

export async function fetchAllContacts(): Promise<Contact[]> {
  const { data, error, status } = await supabase
    .from('contacts')
    .select('id,group_name,name,role_title,phone_e164,has_whatsapp,sort,active')
    .order('sort')
    .order('name')
  if (error) throw toApiError(error, status)
  return data ?? []
}

export async function fetchAllIncidents(): Promise<Incident[]> {
  return fetchAllPages<Incident>((from, to) =>
    supabase
      .from('incidents')
      .select('id,apartment_id,item_id,free_text,kind,qty,status,photo_paths,comment,created_by,created_at,resolved_by,resolved_at,resolution_note,writeoff_move_id,client_op_id')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  )
}

// ---- Mutations (all through RPC) ----

export async function postDocument(params: {
  op: string
  lines: Array<{ item_id: number; qty: number; unit_cost?: number | null }>
  apartment?: number | null
  staff?: number | null
  supplier?: number | null
  note?: string | null
}): Promise<PostDocumentResult> {
  const { data, error, status } = await supabase.rpc('post_document', {
    p_op: params.op,
    p_lines: params.lines,
    p_apartment: params.apartment ?? null,
    p_staff: params.staff ?? null,
    p_supplier: params.supplier ?? null,
    p_note: params.note ?? null,
  })
  if (error) throw toApiError(error, status)
  return data as PostDocumentResult
}

export async function fetchSuppliers(): Promise<Supplier[]> {
  const { data, error, status } = await supabase
    .from('suppliers')
    .select('id,name,phone,note')
    .order('name')
  if (error) throw toApiError(error, status)
  return data ?? []
}

export async function fetchDocuments(docType?: string, offset = 0, limit = 50): Promise<DocumentWithSupplier[]> {
  let query = supabase
    .from('documents')
    .select('id,doc_type,number,doc_date,supplier_id,status,note,total_cost,created_at')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (docType && docType !== 'all') query = query.eq('doc_type', docType)
  const { data, error, status } = await query
  if (error) throw toApiError(error, status)
  const rows = (data ?? []) as DocumentRow[]
  const supplierIds = Array.from(new Set(rows.map((r) => r.supplier_id).filter((id): id is number => id !== null)))
  let supplierMap = new Map<number, string>()
  if (supplierIds.length) {
    const supResults = await Promise.all(chunk(supplierIds).map((batch) => supabase.from('suppliers').select('id,name').in('id', batch)))
    for (const r of supResults) if (r.error) throw toApiError(r.error, r.status)
    supplierMap = new Map(supResults.flatMap((r) => (r.data ?? []).map((s: { id: number; name: string }) => [s.id, s.name])))
  }
  return rows.map((r) => ({ ...r, supplier_name: r.supplier_id ? supplierMap.get(r.supplier_id) ?? null : null }))
}

export async function fetchDocumentMoves(docId: string): Promise<Array<StockMoveRow & { item_name: string; item_base_unit: string; item_pack_size: number; item_pack_label: string }>> {
  const { data, error, status } = await supabase
    .from('stock_moves')
    .select('id,item_id,from_loc,to_loc,qty,unit_cost,source_type,source_id,apartment_id,staff_id,note,moved_at')
    .eq('doc_id', docId)
    .order('moved_at', { ascending: false })
    .order('id', { ascending: false })
  if (error) throw toApiError(error, status)
  const rows = (data ?? []) as StockMoveRow[]
  const itemIds = Array.from(new Set(rows.map((r) => r.item_id)))
  const locationIds = Array.from(new Set(rows.flatMap((r) => [r.from_loc, r.to_loc])))

  const [itemsResults, locationsResults] = await Promise.all([
    itemIds.length ? Promise.all(chunk(itemIds).map((batch) => supabase.from('items').select('id,name,base_unit,pack_size,pack_label').in('id', batch))) : [],
    locationIds.length ? Promise.all(chunk(locationIds).map((batch) => supabase.from('locations').select('id,name,type').in('id', batch))) : [],
  ])
  for (const r of itemsResults) if (r.error) throw toApiError(r.error, r.status)
  for (const r of locationsResults) if (r.error) throw toApiError(r.error, r.status)
  const allItems = itemsResults.flatMap((r) => r.data ?? [])
  const allLocations = locationsResults.flatMap((r) => r.data ?? [])

  const itemMap = new Map(allItems.map((i) => [i.id, i]))
  const locationMap = new Map(allLocations.map((l) => [l.id, l]))
  return rows.map((r) => {
    const item = itemMap.get(r.item_id)
    return {
      ...r,
      from_location: locationMap.get(r.from_loc),
      to_location: locationMap.get(r.to_loc),
      item_name: item?.name ?? '?',
      item_base_unit: item?.base_unit ?? 'pcs',
      item_pack_size: item?.pack_size ?? 1,
      item_pack_label: item?.pack_label ?? '',
    }
  })
}

export async function fetchAttachments(docId: string): Promise<AttachmentRow[]> {
  const { data, error, status } = await supabase
    .from('attachments')
    .select('id,doc_id,incident_id,kind,storage_path,mime,created_at')
    .eq('doc_id', docId)
    .order('created_at', { ascending: false })
  if (error) throw toApiError(error, status)
  return data ?? []
}

export async function uploadAttachment(docId: string, file: File): Promise<AttachmentRow> {
  const validationError = validateReceipt(file)
  if (validationError) throw toApiError(new Error(validationError))

  const mime = resolveMime(file) ?? 'application/octet-stream'
  const ext = extForMime(mime)
  const path = `${docId}/${crypto.randomUUID()}${ext}`

  const { error: uploadError } = await supabase.storage
    .from('receipts')
    .upload(path, file, { upsert: false, contentType: mime })
  if (uploadError) throw toApiError(uploadError)

  const { data, error, status } = await supabase
    .from('attachments')
    .insert({ doc_id: docId, kind: 'receipt', storage_path: path, mime })
    .select('id,doc_id,incident_id,kind,storage_path,mime,created_at')
    .single()
  if (error) {
    await supabase.storage.from('receipts').remove([path])
    throw toApiError(error, status)
  }
  return data as AttachmentRow
}

export async function createSignedUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from('receipts')
    .createSignedUrl(path, 3600)
  if (error) throw toApiError(error)
  return data.signedUrl
}

export async function deleteAttachment(id: string, storagePath: string): Promise<void> {
  const { error, status } = await supabase.from('attachments').delete().eq('id', id)
  if (error) throw toApiError(error, status)
  const { error: storageError } = await supabase.storage.from('receipts').remove([storagePath])
  if (storageError) console.error('Failed to remove attachment file:', storageError)
}

export async function issueMissing(apartmentId: number): Promise<IssueMissingResult> {
  const { data, error, status } = await supabase.rpc('issue_missing_to_apartment', {
    p_apartment: apartmentId,
  })
  if (error) throw toApiError(error, status)
  return data as IssueMissingResult
}

export async function reverseCleaning(eventId: string, reason: string | null): Promise<ReverseCleaningResult> {
  const { data, error, status } = await supabase.rpc('reverse_cleaning', {
    p_event: eventId,
    p_reason: reason,
  })
  if (error) throw toApiError(error, status)
  return data as ReverseCleaningResult
}

export async function recalculateCleaning(
  eventId: string,
  cleanedAt: string | null,
  staffIds: number[] | null,
  leadStaffId: number | null,
): Promise<RecalculateCleaningResult> {
  const { data, error, status } = await supabase.rpc('recalculate_cleaning', {
    p_event: eventId,
    p_cleaned_at: cleanedAt,
    p_staff_ids: staffIds,
    p_lead_staff_id: leadStaffId,
  })
  if (error) throw toApiError(error, status)
  return data as RecalculateCleaningResult
}

export async function approveIncident(
  incidentId: string,
  decision: 'confirm' | 'reject',
  note: string | null,
  force: boolean,
): Promise<ApproveIncidentResult> {
  const { data, error, status } = await supabase.rpc('approve_incident', {
    p_incident: incidentId,
    p_decision: decision,
    p_note: note,
    p_force: force,
  })
  if (error) throw toApiError(error, status)
  return data as ApproveIncidentResult
}

// ---- Staff CRUD (admin_all policy) ----

const PHONE_RE = /^\+[0-9]{8,15}$/

export async function createStaff(name: string, role: string, phone: string): Promise<void> {
  const trimmedName = name.trim()
  const trimmedPhone = phone.trim()
  if (trimmedPhone && !PHONE_RE.test(trimmedPhone)) throw toApiError(new Error(currentDict().invalidPhoneFormat))
  const { error, status } = await supabase
    .from('staff')
    .insert({ full_name: trimmedName, role, phone: trimmedPhone || null, active: true })
  if (error) throw toApiError(error, status)
}

export async function updateStaff(id: number, patch: Partial<Pick<Staff, 'full_name' | 'role' | 'phone' | 'active'>>): Promise<void> {
  const { error, status } = await supabase.from('staff').update(patch).eq('id', id)
  if (error) throw toApiError(error, status)
}

export async function archiveStaff(id: number): Promise<void> {
  const { error, status } = await supabase.from('staff').update({ active: false }).eq('id', id)
  if (error) throw toApiError(error, status)
}

export async function staffHasHistory(staffId: number): Promise<boolean> {
  const [moves, cleaningStaff] = await Promise.all([
    supabase.from('stock_moves').select('id', { head: true, count: 'exact' }).eq('staff_id', staffId),
    supabase.from('cleaning_event_staff').select('event_id', { head: true, count: 'exact' }).eq('staff_id', staffId),
  ])
  return (moves.count ?? 0) > 0 || (cleaningStaff.count ?? 0) > 0
}

export async function deleteStaff(id: number): Promise<void> {
  const { error, status } = await supabase.from('staff').delete().eq('id', id)
  if (error) throw toApiError(error, status)
}

// ---- Contacts CRUD (admin_all policy) ----

export async function createContact(params: {
  name: string
  group_name: string | null
  role_title: string | null
  phone_e164: string
  has_whatsapp: boolean
  sort: number
}): Promise<void> {
  const trimmedName = params.name.trim()
  const trimmedPhone = params.phone_e164.trim()
  if (!PHONE_RE.test(trimmedPhone)) throw toApiError(new Error(currentDict().invalidPhoneFormat))
  const { error, status } = await supabase.from('contacts').insert({
    group_name: params.group_name,
    name: trimmedName,
    role_title: params.role_title,
    phone_e164: trimmedPhone,
    has_whatsapp: params.has_whatsapp,
    sort: params.sort,
    active: true,
  })
  if (error) throw toApiError(error, status)
}

export async function updateContact(id: number, patch: Partial<Omit<Contact, 'id'>>): Promise<void> {
  const { error, status } = await supabase.from('contacts').update(patch).eq('id', id)
  if (error) throw toApiError(error, status)
}

export async function deleteContact(id: number): Promise<void> {
  const { error, status } = await supabase.from('contacts').delete().eq('id', id)
  if (error) throw toApiError(error, status)
}

// ---- Norm rules CRUD (admin_all policy) ----

export async function upsertNormRule(params: {
  id?: number
  norm_type: string
  apartment_id: number | null
  apt_type: string | null
  item_id: number
  qty: number
  note?: string | null
}): Promise<void> {
  const payload = {
    norm_type: params.norm_type,
    apartment_id: params.apartment_id,
    apt_type: params.apt_type,
    item_id: params.item_id,
    qty: params.qty,
    note: params.note ?? null,
  }
  if (params.id) {
    const { error, status } = await supabase.from('norm_rules').update(payload).eq('id', params.id)
    if (error) throw toApiError(error, status)
  } else {
    const { error, status } = await supabase.from('norm_rules').insert(payload)
    if (error) throw toApiError(error, status)
  }
}

export async function deleteNormRule(id: number): Promise<void> {
  const { error, status } = await supabase.from('norm_rules').delete().eq('id', id)
  if (error) throw toApiError(error, status)
}

// ---- Categories CRUD (admin_all policy) ----

export async function fetchCategories(): Promise<Category[]> {
  const { data, error, status } = await supabase
    .from('categories')
    .select('id,name,kind,sort')
    .order('sort')
    .order('name')
  if (error) throw toApiError(error, status)
  return data ?? []
}

export async function createCategory(name: string, kind: ItemKind, sort: number): Promise<void> {
  const { error, status } = await supabase.from('categories').insert({ name, kind, sort })
  if (error) throw toApiError(error, status)
}

export async function updateCategory(id: number, patch: Partial<Pick<Category, 'name' | 'kind' | 'sort'>>): Promise<void> {
  const { error, status } = await supabase.from('categories').update(patch).eq('id', id)
  if (error) throw toApiError(error, status)
}

export async function deleteCategory(id: number): Promise<void> {
  const { data: items, error: itemsError, status: itemsStatus } = await supabase
    .from('items')
    .select('id', { head: true, count: 'exact' })
    .eq('category_id', id)
  if (itemsError) throw toApiError(itemsError, itemsStatus)
  if ((items ?? []).length > 0 || (items as unknown as { count?: number }).count) {
    const { count } = await supabase.from('items').select('id', { head: true, count: 'exact' }).eq('category_id', id)
    if ((count ?? 0) > 0) throw toApiError(new Error(currentDict().categoryHasItems))
  }
  const { error, status } = await supabase.from('categories').delete().eq('id', id)
  if (error) throw toApiError(error, status)
}

// ---- Items CRUD (admin_all policy) ----

export async function fetchItems(): Promise<Item[]> {
  return fetchAllPages<Item>((from, to) =>
    supabase
      .from('items')
      .select('id,category_id,name,base_unit,pack_size,pack_label,min_stock,track_on_hand,qr_code,photo_path,active,sort,supplier_id')
      .order('name')
      .order('id')
      .range(from, to),
  )
}

export async function createItem(params: {
  category_id: number
  name: string
  base_unit: BaseUnit
  pack_size: number
  pack_label: string
  min_stock: number | null
  track_on_hand: boolean
  supplier_id?: number | null
}): Promise<void> {
  const { error, status } = await supabase.from('items').insert({ ...params, active: true, sort: 0 })
  if (error) throw toApiError(error, status)
}

export async function updateItem(id: number, patch: Partial<Pick<Item, 'name' | 'category_id' | 'base_unit' | 'pack_size' | 'pack_label' | 'min_stock' | 'track_on_hand' | 'active' | 'supplier_id'>>): Promise<void> {
  const { error, status } = await supabase.from('items').update(patch).eq('id', id)
  if (error) throw toApiError(error, status)
}

export async function archiveItem(id: number): Promise<void> {
  const { error, status } = await supabase.from('items').update({ active: false }).eq('id', id)
  if (error) throw toApiError(error, status)
}

export async function deleteItem(id: number): Promise<void> {
  const { error, status } = await supabase.from('items').delete().eq('id', id)
  if (error) throw toApiError(error, status)
}

export async function itemHasHistory(itemId: number): Promise<boolean> {
  const [moves, norms, poLines, invLines] = await Promise.all([
    supabase.from('stock_moves').select('id', { head: true, count: 'exact' }).eq('item_id', itemId),
    supabase.from('norm_rules').select('id', { head: true, count: 'exact' }).eq('item_id', itemId),
    supabase.from('purchase_order_lines').select('id', { head: true, count: 'exact' }).eq('item_id', itemId),
    supabase.from('inventory_lines').select('id', { head: true, count: 'exact' }).eq('item_id', itemId),
  ])
  return (moves.count ?? 0) > 0 || (norms.count ?? 0) > 0 || (poLines.count ?? 0) > 0 || (invLines.count ?? 0) > 0
}
