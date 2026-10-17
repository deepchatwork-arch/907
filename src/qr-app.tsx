import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QrLayout } from '@/modules/qr/QrLayout'
import { QrIndexPage } from '@/modules/qr/QrIndexPage'
import { QrApartmentPage } from '@/modules/qr/QrApartmentPage'
import { CleaningSheet } from '@/modules/cleaning/CleaningSheet'
import { IncidentForm } from '@/modules/incidents/IncidentForm'
import { QrHistoryPage } from '@/modules/qr/QrHistoryPage'
import { useAuth, setupAuthListener } from '@/modules/core/store'
import { LoginScreen } from '@/modules/core/AuthScreens'
import { useI18n } from '@/i18n'
import { ToastContainer } from '@/lib/toast'
import { Package, RefreshCw } from 'lucide-react'
import { Suspense, useEffect, lazy } from 'react'

const SentryErrorBoundary = lazy(() => import('@/components/SentryErrorBoundary').then(m => ({ default: m.SentryErrorBoundary })))

function Loading() {
  const { t } = useI18n()
  return <div className="px-4 pt-8 text-center text-muted">{t.app.loading}</div>
}

function QrCleanRoute() {
  const id = window.location.hash.match(/\/qr\/(\d+)\/clean/)?.[1]
  const backTo = `/qr/${id}`
  return (
    <>
      <QrApartmentPage />
      <CleaningSheet backTo={backTo} />
    </>
  )
}

function QrIncidentRoute() {
  const id = window.location.hash.match(/\/qr\/(\d+)\/incident/)?.[1]
  const backTo = `/qr/${id}`
  return (
    <>
      <QrApartmentPage />
      <IncidentForm backTo={backTo} />
    </>
  )
}

function QrApp() {
  const { t, lang } = useI18n()
  const state = useAuth((s) => s.state)
  const init = useAuth((s) => s.init)
  const retryInit = useAuth((s) => s.retryInit)
  const profile = useAuth((s) => s.profile)

  useEffect(() => {
    setupAuthListener()
    init()
  }, [init])

  useEffect(() => {
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
    document.documentElement.lang = lang
  }, [lang])

  let content: React.ReactNode
  if (state === 'loading') {
    content = (
      <div className="min-h-screen bg-app flex flex-col items-center justify-center">
        <div className="w-14 h-14 bg-accent rounded-2xl flex items-center justify-center mb-4 animate-pulse">
          <Package className="w-7 h-7 text-white" />
        </div>
        <p className="text-sm text-muted">{t.app.loading}</p>
      </div>
    )
  } else if (state === 'no-connection') {
    content = (
      <div className="min-h-screen bg-app flex flex-col items-center justify-center px-6">
        <div className="w-14 h-14 bg-warn-soft rounded-2xl flex items-center justify-center mb-4">
          <Package className="w-7 h-7 text-warn" />
        </div>
        <p className="text-sm text-muted mb-4">{t.offline}</p>
        <button onClick={retryInit} className="flex items-center gap-2 bg-accent text-white rounded-xl px-5 py-2.5 text-sm font-medium">
          <RefreshCw className="w-4 h-4" />
          {t.retry}
        </button>
      </div>
    )
  } else if (state === 'login' || !profile) {
    content = <LoginScreen title={t.qr.title} subtitle={t.qr.loginSubtitle} />
  } else {
    const role = profile.role
    const canUseQr = role === 'admin' || role === 'manager' || role === 'supervisor'
    content = canUseQr ? (
      <HashRouter>
        <Routes>
          <Route path="/qr" element={<QrLayout><QrIndexPage /></QrLayout>} />
          <Route path="/qr/:id" element={<QrLayout><QrApartmentPage /></QrLayout>} />
          <Route path="/qr/:id/clean" element={<QrLayout><QrCleanRoute /></QrLayout>} />
          <Route path="/qr/:id/incident" element={<QrLayout><QrIncidentRoute /></QrLayout>} />
          <Route path="/qr/:id/history" element={<QrLayout><QrHistoryPage /></QrLayout>} />
          <Route path="*" element={<Navigate to="/qr" replace />} />
        </Routes>
      </HashRouter>
    ) : (
      <div className="min-h-screen bg-app flex flex-col items-center justify-center px-6 text-center">
        <p className="text-sm text-muted max-w-xs">{t.qr.qrAccessDenied}</p>
        <button onClick={() => useAuth.getState().signOut()} className="mt-4 text-sm text-accent font-medium">
          {t.qr.logout}
        </button>
      </div>
    )
  }

  return (
    <>
      {content}
      <ToastContainer />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <SentryErrorBoundary>
        <QrApp />
      </SentryErrorBoundary>
    </Suspense>
  </StrictMode>
)
