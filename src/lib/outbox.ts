import { get, update } from 'idb-keyval'
import { supabase } from '@/lib/supabase'
import { toApiError } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { currentDict } from '@/i18n'

export interface OutboxEntry {
  id: string
  userId: string
  apartmentId: number
  cleanedAt: string
  clientOpId: string
  staffIds: number[]
  leadStaffId: number | null
  note: string | null
  createdAt: number
  status: 'pending' | 'failed'
  lastError: string | null
  attempts: number
}

const OUTBOX_KEY = 'cleaning-outbox'
const MAX_ATTEMPTS = 20

type Listener = () => void
const listeners = new Set<Listener>()

function notify() {
  for (const l of listeners) l()
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export async function getOutboxSummary(userId: string): Promise<{ pending: number; failed: number }> {
  const all = (await get<OutboxEntry[]>(OUTBOX_KEY)) ?? []
  const mine = all.filter((e) => e.userId === userId)
  return {
    pending: mine.filter((e) => e.status === 'pending').length,
    failed: mine.filter((e) => e.status === 'failed').length,
  }
}

export async function getOutboxEntries(userId: string): Promise<OutboxEntry[]> {
  const all = (await get<OutboxEntry[]>(OUTBOX_KEY)) ?? []
  return all.filter((e) => e.userId === userId).sort((a, b) => a.createdAt - b.createdAt)
}

export async function addOutboxEntry(entry: Omit<OutboxEntry, 'status' | 'lastError' | 'attempts'>): Promise<void> {
  const full: OutboxEntry = {
    ...entry,
    status: 'pending',
    lastError: null,
    attempts: 0,
  }
  await update<OutboxEntry[]>(OUTBOX_KEY, (existing) => [...(existing ?? []), full])
  notify()
}

async function removeOutboxEntry(id: string): Promise<void> {
  await update<OutboxEntry[]>(OUTBOX_KEY, (existing) =>
    (existing ?? []).filter((e) => e.id !== id),
  )
  notify()
}

export async function deleteFailedEntry(id: string): Promise<void> {
  await removeOutboxEntry(id)
}

export async function retryFailedEntry(id: string): Promise<void> {
  await updateOutboxEntry(id, (e) => {
    e.status = 'pending'
    e.attempts = 0
    e.lastError = null
  })
  notify()
}

async function updateOutboxEntry(id: string, mutate: (e: OutboxEntry) => void): Promise<void> {
  await update<OutboxEntry[]>(OUTBOX_KEY, (existing) => {
    const list = existing ?? []
    const idx = list.findIndex((e) => e.id === id)
    if (idx === -1) return list
    mutate(list[idx])
    return list
  })
}

let flushInProgress = false

export async function flushOutbox(userId: string): Promise<void> {
  if (flushInProgress) return
  flushInProgress = true
  try {
    const entries = await getOutboxEntries(userId)
    const pending = entries.filter((e) => e.status === 'pending')
    if (pending.length === 0) return

    let anySynced = false

    for (const entry of pending) {
      const { error, status } = await supabase.rpc('complete_cleaning', {
        p_apartment_id: entry.apartmentId,
        p_cleaned_at: entry.cleanedAt,
        p_client_op_id: entry.clientOpId,
        p_staff_ids: entry.staffIds,
        p_lead_staff_id: entry.leadStaffId,
        p_note: entry.note,
      })

      if (!error) {
        await removeOutboxEntry(entry.id)
        anySynced = true
        continue
      }

      const apiError = toApiError(error, status)

      if (apiError.code === '23505') {
        await removeOutboxEntry(entry.id)
        anySynced = true
        continue
      }

      if (apiError.isAuth) {
        await updateOutboxEntry(entry.id, (e) => {
          e.attempts += 1
          e.lastError = apiError.message
        })
        notify()
        const { data: { session } } = await supabase.auth.refreshSession()
        if (!session) {
          toast(currentDict().errors.auth, 'error')
        }
        break
      }

      if (apiError.status != null && apiError.status >= 500) {
        const newAttempts = entry.attempts + 1
        if (newAttempts >= MAX_ATTEMPTS) {
          await updateOutboxEntry(entry.id, (e) => {
            e.status = 'failed'
            e.lastError = apiError.message
            e.attempts = newAttempts
          })
        } else {
          await updateOutboxEntry(entry.id, (e) => {
            e.attempts = newAttempts
            e.lastError = apiError.message
          })
        }
        notify()
        break
      }

      if (apiError.isNetwork) {
        await updateOutboxEntry(entry.id, (e) => {
          e.attempts += 1
          e.lastError = apiError.message
        })
        notify()
        break
      }

      if (apiError.code && (apiError.status == null || apiError.status < 500)) {
        await updateOutboxEntry(entry.id, (e) => {
          e.status = 'failed'
          e.lastError = apiError.message
        })
        notify()
        continue
      }

      const newAttempts = entry.attempts + 1
      if (newAttempts >= MAX_ATTEMPTS) {
        await updateOutboxEntry(entry.id, (e) => {
          e.status = 'failed'
          e.lastError = apiError.message
          e.attempts = newAttempts
        })
      } else {
        await updateOutboxEntry(entry.id, (e) => {
          e.attempts = newAttempts
          e.lastError = apiError.message
        })
      }
      notify()
    }

    if (anySynced) {
      const d = currentDict()
      toast(d.errors.outboxSynced, 'success')
    }
  } finally {
    flushInProgress = false
    notify()
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null
let onlineHandler: (() => void) | null = null
let visibleHandler: (() => void) | null = null

export function startOutboxSync(userId: string): void {
  stopOutboxSync()

  flushOutbox(userId).catch(() => {})

  onlineHandler = () => flushOutbox(userId).catch(() => {})
  visibleHandler = () => {
    if (document.visibilityState === 'visible') flushOutbox(userId).catch(() => {})
  }

  window.addEventListener('online', onlineHandler)
  document.addEventListener('visibilitychange', visibleHandler)

  intervalId = setInterval(async () => {
    const summary = await getOutboxSummary(userId)
    if (summary.pending > 0) {
      flushOutbox(userId).catch(() => {})
    }
  }, 30000)
}

export function stopOutboxSync(): void {
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
  if (onlineHandler) {
    window.removeEventListener('online', onlineHandler)
    onlineHandler = null
  }
  if (visibleHandler) {
    document.removeEventListener('visibilitychange', visibleHandler)
    visibleHandler = null
  }
}
