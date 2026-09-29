/*
 * Copyright 2026 Uraniborg authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LandingPage } from '@/LandingPage';
import { Layout } from '@/analyze/components/Layout';
import { useApp } from '@/analyze/lib/store';
import { ANALYZE_PAGES, ANALYZE_ROOT, analyzePath } from '@/analyze/paths';
import { LoadPage } from '@/analyze/routes/LoadPage';
import { OverviewPage } from '@/analyze/routes/OverviewPage';
import { PackagesPage } from '@/analyze/routes/PackagesPage';
import { PackageDetailPage } from '@/analyze/routes/PackageDetailPage';
import { CertificatesPage } from '@/analyze/routes/CertificatesPage';
import { CertificateDetailPage } from '@/analyze/routes/CertificateDetailPage';
import { PermissionsPage } from '@/analyze/routes/PermissionsPage';
import { ComponentsPage } from '@/analyze/routes/ComponentsPage';
import { SharedUidsPage } from '@/analyze/routes/SharedUidsPage';
import { IntegrityPage } from '@/analyze/routes/IntegrityPage';
import { BinariesPage } from '@/analyze/routes/BinariesPage';
import { DevicePage } from '@/analyze/routes/DevicePage';
import { ComparePage } from '@/analyze/routes/ComparePage';

/** Opens Analyze on the overview if something is loaded, else on the loader. */
function AnalyzeHome() {
  const hasObservation = useApp((s) => s.observations.length > 0);
  return <Navigate to={analyzePath(hasObservation ? '/overview' : '/load')} replace />;
}

/**
 * Analyze pages used to live at the root (`#/packages`, ...). Links to them
 * are saved and shared, so forward them to the same page under Analyze,
 * keeping the query and the fragment: `#/packages?proof=failed` and
 * `#/device#diagnostics` must still land where they used to.
 */
function LegacyRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={{ pathname: ANALYZE_ROOT + pathname, search, hash }} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path={ANALYZE_ROOT} element={<Layout />}>
        <Route index element={<AnalyzeHome />} />
        <Route path="load" element={<LoadPage />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="packages" element={<PackagesPage />} />
        <Route path="packages/:name" element={<PackageDetailPage />} />
        <Route path="certificates" element={<CertificatesPage />} />
        <Route path="certificates/:hash" element={<CertificateDetailPage />} />
        <Route path="permissions" element={<PermissionsPage />} />
        <Route path="components" element={<ComponentsPage />} />
        <Route path="shared-uids" element={<SharedUidsPage />} />
        <Route path="integrity" element={<IntegrityPage />} />
        <Route path="binaries" element={<BinariesPage />} />
        <Route path="device" element={<DevicePage />} />
        <Route path="compare" element={<ComparePage />} />
        <Route path="*" element={<Navigate to={ANALYZE_ROOT} replace />} />
      </Route>
      {ANALYZE_PAGES.map((page) => (
        <Route key={page} path={`/${page}/*`} element={<LegacyRedirect />} />
      ))}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
