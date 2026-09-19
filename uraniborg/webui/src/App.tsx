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

import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { useApp } from '@/lib/store';
import { LoadPage } from '@/routes/LoadPage';
import { OverviewPage } from '@/routes/OverviewPage';
import { PackagesPage } from '@/routes/PackagesPage';
import { PackageDetailPage } from '@/routes/PackageDetailPage';
import { CertificatesPage } from '@/routes/CertificatesPage';
import { CertificateDetailPage } from '@/routes/CertificateDetailPage';
import { PermissionsPage } from '@/routes/PermissionsPage';
import { ComponentsPage } from '@/routes/ComponentsPage';
import { SharedUidsPage } from '@/routes/SharedUidsPage';
import { IntegrityPage } from '@/routes/IntegrityPage';
import { BinariesPage } from '@/routes/BinariesPage';
import { DevicePage } from '@/routes/DevicePage';
import { ComparePage } from '@/routes/ComparePage';

export function App() {
  const hasObservation = useApp((s) => s.observations.length > 0);

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to={hasObservation ? '/overview' : '/load'} replace />} />
        <Route path="/load" element={<LoadPage />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/packages" element={<PackagesPage />} />
        <Route path="/packages/:name" element={<PackageDetailPage />} />
        <Route path="/certificates" element={<CertificatesPage />} />
        <Route path="/certificates/:hash" element={<CertificateDetailPage />} />
        <Route path="/permissions" element={<PermissionsPage />} />
        <Route path="/components" element={<ComponentsPage />} />
        <Route path="/shared-uids" element={<SharedUidsPage />} />
        <Route path="/integrity" element={<IntegrityPage />} />
        <Route path="/binaries" element={<BinariesPage />} />
        <Route path="/device" element={<DevicePage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
