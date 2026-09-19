#!/usr/bin/env python3
# Copyright 2026 Uraniborg authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

"""Generates a synthetic Hubble observation for demoing/testing the web UI.

The output is byte-compatible with what Hubble writes, including the hand-rolled
envelope (`{"version": ..., "total<X>": N, "<xs>": [...]}`), so it exercises the
real load path rather than a mock.

Two observations are produced:
  sample-data/pixel-target/   a plausible OEM build, in the 2.2.0 schema
  sample-data/gsi-baseline/   a trimmed GSI-like baseline for the Compare view,
                              deliberately in the pre-2.2.0 schema

The target covers all four signing states the UI distinguishes — single signer,
v3 rotation lineage, concurrent co-signers, and a package that rotated away from
the platform key — so the signing screens can be reviewed without a device.

Signing certificates are real, self-signed X.509 certs generated with openssl,
so the certificate page decodes genuine DER and the SHA-256 fingerprint check
actually verifies.
"""

import base64
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile

VERSION = "2.2.0"
# The GSI baseline is deliberately emitted in the pre-2.2.0 shape, without
# `signingInfo`. Real fleets compare against captures taken months apart, so the
# degraded path — where a multi-certificate package cannot be resolved into a
# rotation lineage or a co-signer set — needs to be reachable in the demo data
# rather than only in tests.
LEGACY_VERSION = "2.1.0"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sample-data")

SIGNERS = [
    ("platform", "/CN=Android Platform/O=Example Mobility Corp/C=US"),
    ("oem-apps", "/CN=Example Apps Signing/O=Example Mobility Corp/C=US"),
    # Successor to oem-apps. One package rotates onto it, so the sample data
    # contains a real v3 lineage and the same certificate is simultaneously an
    # active signer for some packages and a retired ancestor for another.
    ("oem-apps-v2", "/CN=Example Apps Signing (2024)/O=Example Mobility Corp/C=US"),
    ("google", "/CN=Google Play Services/O=Google LLC/C=US"),
    ("partner", "/CN=Nebula Partner Apps/O=Nebula Digital Ltd/C=SG"),
    # The comma in the O is deliberate. RFC 4514 stores it escaped, so the
    # subject reads `O=Orbit Telecom\, Inc.`, and anything that splits a DN on
    # commas truncates the name to `Orbit Telecom\`. Keeping one such signer in
    # the demo data makes that class of bug visible without a real handset.
    ("carrier", "/CN=Carrier Bundle/O=Orbit Telecom, Inc./C=GB"),
    # Appears *only* as a retired ancestor, so the "retired key" role - a
    # certificate that can no longer ship an update to anything on the device -
    # is reachable in the demo rather than only on a real handset.
    ("nebula-legacy", "/CN=Nebula Apps (legacy)/O=Nebula Digital Ltd/C=SG"),
]


def make_certs(workdir):
    """Creates one self-signed cert per signer; returns name -> (sha256, b64der)."""
    out = {}
    for name, subject in SIGNERS:
        key = os.path.join(workdir, f"{name}.key")
        der = os.path.join(workdir, f"{name}.der")
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
             "-keyout", key, "-outform", "DER", "-out", der,
             "-days", "10950", "-subj", subject, "-sha256"],
            check=True, capture_output=True)
        with open(der, "rb") as f:
            raw = f.read()
        out[name] = (hashlib.sha256(raw).hexdigest(),
                     base64.b64encode(raw).decode("ascii"))
    return out


def sha256_of(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def component(name, exported=False, enabled=True, permission=None):
    return {
        "name": name,
        "isEnabled": enabled,
        "isExported": exported,
        "labels": [],
        "desc": None,
        "permission": permission,
    }


def provider(name, authority, read=None, write=None, exported=True,
             grant_uri=False, paths=()):
    """A ContentProvider entry.

    `read` and `write` are the *resolved* ProviderInfo fields, which is what
    Hubble records: Android's manifest parser has already folded a
    provider-wide android:permission into both by the time they are read, so
    leaving both None here means genuinely nothing is enforced.
    """
    return {
        "name": name,
        "isEnabled": True,
        "isExported": exported,
        "labels": [],
        "desc": None,
        "authority": authority,
        "grantUriPermissions": grant_uri,
        "permissionRead": read,
        "permissionWrite": write,
        "pathPermissions": [
            {"path": path, "type": "literal", "permissionRead": r, "permissionWrite": w}
            for path, r, w in paths
        ],
        "uriPermissionPatterns": [],
        "forceUriPermissions": None,
    }


def signing_block(signer, retired=(), co_signers=()):
    """Builds a Hubble >= 2.2.0 `signingInfo` block and the matching `certIds`.

    `signer` is always the certificate that can ship an update *today*.
    `retired` are its rotation ancestors, oldest first; `co_signers` are
    concurrent signers. The two are mutually exclusive, because v3 key rotation
    is not supported for multi-signer APKs.

    `certIds` is derived rather than passed in, so the sample data reproduces
    exactly the ambiguity real output has: the flat list looks the same for a
    two-entry lineage and a two-signer set, and only `signingInfo` tells them
    apart. See docs/hubble_results.md, "Determining Package Signing Certificate
    Lineage vs. Co-Signing".
    """
    if co_signers:
        active = [signer] + list(co_signers)
        info = {
            "hasMultipleSigners": True,
            "hasPastSigningCertificates": False,
            "apkContentsSigners": active,
            "signingCertificateLineage": [],
            "platformSignatureMatch": None,
        }
        return info, list(active)
    lineage = list(retired) + [signer]
    info = {
        "hasMultipleSigners": False,
        "hasPastSigningCertificates": bool(retired),
        "apkContentsSigners": [signer],
        "signingCertificateLineage": lineage,
        "platformSignatureMatch": None,
    }
    return info, list(lineage)


def active_signers(pkg):
    """Current signer(s), whatever schema the package was emitted in."""
    info = pkg.get("signingInfo")
    return info["apkContentsSigners"] if info else pkg["certIds"]


def package(name, label, signer, **kw):
    install_location = kw.get("installLocation", f"/system/app/{label}/{label}.apk")
    signing_info, cert_ids = signing_block(
        signer, kw.get("retiredSigners", ()), kw.get("coSigners", ()))
    p = {
        "hash": sha256_of(f"{name}:{kw.get('versionCode', 1)}"),
        "name": name,
        "label": label,
        "description": kw.get("description"),
        "versionCode": kw.get("versionCode", 1),
        "versionName": kw.get("versionName", "1.0.0"),
        # Ordered oldest-first for a lineage, unordered for a co-signer set —
        # indistinguishable without `signingInfo`, which is the point.
        "certIds": cert_ids,
        "signingInfo": signing_info,
        "isEnabled": kw.get("isEnabled", True),
        "isTestOnly": kw.get("isTestOnly", False),
        "isFactoryTest": False,
        "isSuspended": False,
        "isApex": kw.get("isApex", False),
        "isPreinstalled": kw.get("isPreinstalled", True),
        "isUpdatedSystemApp": kw.get("isUpdatedSystemApp", False),
        "isHidden": False,
        "hasCode": kw.get("hasCode", True),
        "usesCleartextTraffic": kw.get("usesCleartextTraffic", False),
        "installLocation": install_location,
        "permissionsDeclared": kw.get("permissionsDeclared", []),
        "permissionsGranted": kw.get("granted", []),
        "permissionsNotGranted": kw.get("notGranted", []),
        "activities": kw.get("activities", []),
        "services": kw.get("services", []),
        "receivers": kw.get("receivers", []),
        "providers": kw.get("providers", []),
        "firstInstallTime": kw.get("firstInstallTime", 1577836800000),
        "sharedUserId": kw.get("sharedUserId"),
        "sharedUserLabel": 0,
        "splits": kw.get("splits", []),
        "kernelGids": kw.get("kernelGids", [3003]),
        "fileSizeInBytes": kw.get("fileSizeInBytes", random.randint(40_000, 60_000_000)),
    }
    return p


def envelope(total_key, total, list_key, items, version=VERSION):
    return json.dumps(
        {"version": version, total_key: total, list_key: items}, indent=2) + "\n"


def write(directory, filename, content):
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, filename), "w") as f:
        f.write(content)


def build_packages(certs, flavour):
    plat = certs["platform"][0]
    oem = certs["oem-apps"][0]
    oem2 = certs["oem-apps-v2"][0]
    goog = certs["google"][0]
    partner = certs["partner"][0]
    carrier = certs["carrier"][0]
    nebula_legacy = certs["nebula-legacy"][0]

    pkgs = [
        package("android", "Android System", plat,
                installLocation="/system/framework/framework-res.apk",
                sharedUserId="android.uid.system",
                versionName="14", versionCode=34,
                granted=["android.permission.INSTALL_PACKAGES",
                         "android.permission.WRITE_SECURE_SETTINGS",
                         "android.permission.GRANT_RUNTIME_PERMISSIONS",
                         "android.permission.READ_LOGS",
                         "android.permission.MANAGE_USERS"],
                permissionsDeclared=[
                    {"name": "android.permission.INSTALL_PACKAGES",
                     "protLevel": "signature|privileged"},
                    {"name": "android.permission.CAMERA", "protLevel": "dangerous"},
                ],
                activities=[component("com.android.internal.app.ChooserActivity", exported=True)],
                providers=[provider("android.content.SettingsProvider",
                                    "settings",
                                    read="android.permission.READ_SECURE_SETTINGS",
                                    write="android.permission.WRITE_SECURE_SETTINGS")]),
        package("com.android.settings", "Settings", plat,
                sharedUserId="android.uid.system",
                granted=["android.permission.WRITE_SECURE_SETTINGS",
                         "android.permission.MANAGE_USERS",
                         "android.permission.ACCESS_FINE_LOCATION",
                         "android.permission.CAMERA"],
                activities=[component("com.android.settings.Settings", exported=True),
                            component("com.android.settings.DebugActivity")]),
        package("com.android.phone", "Phone Services", plat,
                sharedUserId="android.uid.phone",
                granted=["android.permission.READ_PRIVILEGED_PHONE_STATE",
                         "android.permission.SEND_SMS_NO_CONFIRMATION",
                         "android.permission.RECEIVE_SMS",
                         "android.permission.READ_SMS"],
                services=[component("com.android.phone.TelephonyService", exported=True,
                                    permission="android.permission.BIND_TELECOM_CONNECTION_SERVICE")]),
        package("com.android.systemui", "System UI", plat,
                granted=["android.permission.INTERNAL_SYSTEM_WINDOW",
                         "android.permission.STATUS_BAR_SERVICE",
                         "android.permission.ACCESS_NOTIFICATIONS"],
                receivers=[component("com.android.systemui.BootReceiver", exported=True)]),
        package("com.google.android.gms", "Google Play services", goog,
                installLocation="/product/priv-app/PrebuiltGmsCore/PrebuiltGmsCore.apk",
                versionName="24.12.15", versionCode=241215000,
                granted=["android.permission.ACCESS_FINE_LOCATION",
                         "android.permission.ACCESS_BACKGROUND_LOCATION",
                         "android.permission.READ_CONTACTS",
                         "android.permission.PACKAGE_USAGE_STATS",
                         "android.permission.RECEIVE_BOOT_COMPLETED"],
                notGranted=["android.permission.RECORD_AUDIO"],
                splits=[{"name": "base", "location": "/product/priv-app/PrebuiltGmsCore/PrebuiltGmsCore.apk",
                         "hash": sha256_of("gms-base")},
                        {"name": "config.arm64_v8a",
                         "location": "/product/priv-app/PrebuiltGmsCore/split_config.arm64_v8a.apk",
                         "hash": sha256_of("gms-arm64")}],
                providers=[provider("com.google.android.gms.chimera.GmsProvider",
                                    "com.google.android.gms.chimera",
                                    read="com.google.android.gms.permission.INTERNAL_BROADCAST",
                                    write="com.google.android.gms.permission.INTERNAL_BROADCAST")]),
        package("com.google.android.gsf", "Google Services Framework", goog,
                granted=["android.permission.RECEIVE_BOOT_COMPLETED",
                         "android.permission.ACCESS_NETWORK_STATE"]),
        package("com.android.vending", "Google Play Store", goog,
                installLocation="/data/app/~~abc==/com.android.vending-1/base.apk",
                isUpdatedSystemApp=True,
                versionName="40.1.29", versionCode=84012900,
                granted=["android.permission.INSTALL_PACKAGES",
                         "android.permission.DELETE_PACKAGES",
                         "android.permission.PACKAGE_USAGE_STATS"]),
        # Rotated *away* from the platform key onto the OEM apps key. Android's
        # checkSignatures() falls back to comparing each side's *oldest*
        # ancestor when the current signers differ, and so still answers MATCH
        # here, which is exactly the false positive the UI must not act on: the
        # platform key can no longer ship this package.
        package("com.example.oem.launcher", "Example Launcher", oem,
                retiredSigners=[plat],
                granted=["android.permission.READ_EXTERNAL_STORAGE",
                         "android.permission.PACKAGE_USAGE_STATS"],
                activities=[component("com.example.oem.launcher.Home", exported=True)]),
        # Rotated onto the 2024 OEM key. Shares a UID with packages that have
        # not rotated yet, which Android allows because it joins the shared UID
        # against the whole lineage rather than one certificate.
        package("com.example.oem.assistant", "Example Assistant", oem2,
                retiredSigners=[oem],
                sharedUserId="android.uid.system",
                granted=["android.permission.RECORD_AUDIO",
                         "android.permission.CAMERA",
                         "android.permission.ACCESS_FINE_LOCATION",
                         "android.permission.READ_CONTACTS",
                         "android.permission.SYSTEM_ALERT_WINDOW"],
                usesCleartextTraffic=True,
                services=[component("com.example.oem.assistant.VoiceService", exported=True),
                          component("com.example.oem.assistant.SyncService", exported=True)],
                providers=[provider("com.example.oem.assistant.DataProvider",
                                    "com.example.oem.assistant.data",
                                    read="com.example.oem.permission.READ_ASSISTANT_DATA"),
                           # Unguarded but not exported: the same null pair that
                           # is alarming above is unremarkable here.
                           provider("com.example.oem.assistant.CacheProvider",
                                    "com.example.oem.assistant.cache",
                                    exported=False)]),
        package("com.example.oem.telemetry", "Example Telemetry", oem,
                sharedUserId="android.uid.system",
                usesCleartextTraffic=True,
                granted=["android.permission.READ_PRIVILEGED_PHONE_STATE",
                         "android.permission.READ_LOGS",
                         "android.permission.DUMP",
                         "android.permission.PACKAGE_USAGE_STATS",
                         "android.permission.ACCESS_COARSE_LOCATION"],
                receivers=[component("com.example.oem.telemetry.UploadReceiver", exported=True)]),
        package("com.nebula.cleaner", "Nebula Cleaner", partner,
                # Rotated off a key that signs nothing else, so that key is
                # retired outright.
                retiredSigners=[nebula_legacy],
                installLocation="/product/app/NebulaCleaner/NebulaCleaner.apk",
                usesCleartextTraffic=True,
                granted=["android.permission.WRITE_EXTERNAL_STORAGE",
                         "android.permission.READ_EXTERNAL_STORAGE",
                         "android.permission.PACKAGE_USAGE_STATS",
                         "android.permission.DELETE_PACKAGES",
                         "android.permission.SYSTEM_ALERT_WINDOW"],
                activities=[component("com.nebula.cleaner.MainActivity", exported=True)],
                services=[component("com.nebula.cleaner.BoostService", exported=True)],
                providers=[provider("com.nebula.cleaner.FileProvider",
                                    "com.nebula.cleaner.files",
                                    grant_uri=True,
                                    paths=[("/cache", None,
                                            "com.nebula.cleaner.permission.WRITE_CACHE")])]),
        # Genuinely co-signed: the partner and the carrier both hold a key and
        # an update needs both. Two certIds, same as the assistant above, but
        # the opposite meaning.
        package("com.nebula.appstore", "Nebula App Center", partner,
                coSigners=[carrier],
                installLocation="/product/priv-app/NebulaStore/NebulaStore.apk",
                usesCleartextTraffic=True,
                granted=["android.permission.INSTALL_PACKAGES",
                         "android.permission.DELETE_PACKAGES",
                         "android.permission.RECEIVE_BOOT_COMPLETED",
                         "android.permission.ACCESS_NETWORK_STATE"],
                receivers=[component("com.nebula.appstore.SilentInstallReceiver", exported=True)]),
        package("com.orbit.carrierservices", "Orbit Carrier Services", carrier,
                sharedUserId="android.uid.phone",
                granted=["android.permission.READ_PRIVILEGED_PHONE_STATE",
                         "android.permission.RECEIVE_SMS",
                         "android.permission.SEND_SMS_NO_CONFIRMATION",
                         "android.permission.ACCESS_COARSE_LOCATION"]),
        package("com.android.wallpaper.holospiral", "Holo Spiral Wallpaper", plat,
                hasCode=False, fileSizeInBytes=1_200_000,
                installLocation="/system/app/HoloSpiralWallpaper/HoloSpiralWallpaper.apk"),
        package("com.android.cts.priv.ctsshim", "CtsShim", plat,
                isTestOnly=True, isEnabled=False),
        # Factory CAPEX decompressed at boot: must NOT be classified as updated.
        package("com.google.android.tzdata5", "TimeZone Data", goog, isApex=True,
                installLocation="/data/apex/active/com.google.android.tzdata5@350000000.decompressed.apex",
                versionCode=350000000, versionName="350000000"),
        # Genuinely updated Mainline module.
        package("com.google.android.adservices", "AdServices", goog, isApex=True,
                installLocation="/data/apex/active/com.google.android.adservices@351512020.apex",
                versionCode=351512020, versionName="351512020"),
        package("com.android.i18n", "i18n module", plat, isApex=True,
                installLocation="/system/apex/com.android.i18n.apex",
                versionCode=1),
        package("com.thirdparty.notes", "Quick Notes", partner,
                isPreinstalled=False,
                installLocation="/data/app/~~xyz==/com.thirdparty.notes-1/base.apk",
                firstInstallTime=1717200000000,
                granted=["android.permission.READ_EXTERNAL_STORAGE"]),
    ]

    # Recorded last, because it is a property of the whole set: Hubble reads it
    # from checkSignatures(), which (see hubble_parser.py,
    # `is_platform_signed`) first requires the two *current* signer sets to be
    # equal, then, if either side has a rotation lineage, retries with only each
    # side's *oldest* ancestor. Its false positive — a package that rotated away
    # from the platform key still reads MATCH — is what makes the UI's
    # "descriptive only" disclaimer demonstrable instead of theoretical.
    #
    # The any-overlap test below is a shortcut, not that algorithm. It gives
    # the same verdict here only because the platform key never rotates and no
    # package is co-signed with it; a platform+other co-signed package would
    # read MATCH below but NO_MATCH on a device.
    platform_history = set(
        next(p["certIds"] for p in pkgs if p["name"] == "android"))
    for p in pkgs:
        overlap = platform_history.intersection(p["certIds"])
        p["signingInfo"]["platformSignatureMatch"] = "MATCH" if overlap else "NO_MATCH"

    if flavour == "gsi":
        # A GSI-like baseline: AOSP packages only, no OEM/partner/carrier preloads.
        keep = {"android", "com.android.settings", "com.android.phone",
                "com.android.systemui", "com.android.i18n",
                "com.android.wallpaper.holospiral", "com.android.cts.priv.ctsshim"}
        pkgs = [p for p in pkgs if p["name"] in keep]
        for p in pkgs:
            # Baselines pregrant less.
            p["permissionsGranted"] = p["permissionsGranted"][:2]
            # Downgrade to the pre-2.2.0 shape so the UI's legacy path is
            # reachable from the sample data. `certIds` keeps only what a
            # capture without lineage support could have seen.
            p["certIds"] = list(active_signers(p))
            p["signingInfo"] = None
    return pkgs


def build_dir(directory, certs, flavour, hardware, build_info):
    pkgs = build_packages(certs, flavour)
    version = LEGACY_VERSION if flavour == "gsi" else VERSION
    # Union of both schemas: a certificate can appear only in `signingInfo`
    # (for example an active signer of a package whose certIds carry the
    # lineage), and certificates.txt must still resolve it to a subject.
    used_cert_ids = {c for p in pkgs for c in p["certIds"]}
    for p in pkgs:
        info = p.get("signingInfo")
        if info:
            used_cert_ids.update(info["apkContentsSigners"])
            used_cert_ids.update(info["signingCertificateLineage"])
    certs_out = [{"hash": h, "encodedCert": b64}
                 for (h, b64) in certs.values() if h in used_cert_ids]

    write(directory, "packages.txt",
          envelope("totalPackages", len(pkgs), "packages", pkgs, version=version))
    preinstalled = [p for p in pkgs if p["isPreinstalled"]]
    write(directory, "preinstalled_packages.txt",
          envelope("totalPreinstalledPackages", len(preinstalled),
                   "preinstalledPackages", preinstalled, version=version))
    write(directory, "certificates.txt",
          envelope("totalCerts", len(certs_out), "certs", certs_out, version=version))
    write(directory, "build.txt",
          envelope("totalBuild", 1, "buildInfo", [build_info], version=version))
    write(directory, "hardware.txt",
          envelope("totalHardware", 1, "hwInfo", [hardware], version=version))

    props = "\n".join(
        f"[{k}]: [{v}]" for k, v in [
            ("ro.build.fingerprint", build_info["fingerprint"]),
            ("ro.build.version.sdk", str(build_info["apiLevel"])),
            ("ro.build.version.security_patch", build_info["securityPatchLevel"]),
            ("ro.product.manufacturer", hardware["oem"]),
            ("ro.product.model", hardware["modelName"]),
            ("ro.boot.verifiedbootstate", "green"),
            ("ro.debuggable", "0"),
            ("ro.secure", "1"),
            ("persist.sys.locale", build_info["locale"]),
        ])
    write(directory, "device_properties.txt",
          envelope("totalDeviceProps", 1, "b64EncodedDeviceProps",
                   [{"encodedDevProps": base64.b64encode(props.encode()).decode()}],
                   version=version))

    bins = [{"name": n, "installPath": p, "hash": sha256_of(f"bin:{p}/{n}"),
             "fileSizeInBytes": random.randint(10_000, 900_000)}
            for n, p in [("sh", "/system/bin"), ("toybox", "/system/bin"),
                         ("logcat", "/system/bin"), ("dumpsys", "/system/bin"),
                         ("pm", "/system/bin"), ("run-as", "/system/bin")]]
    write(directory, "binaries.txt", envelope("totalBins", len(bins), "bins", bins, version=version))

    libs = [{"name": n, "installPath": p, "bits": b,
             "hash": sha256_of(f"lib:{p}/{n}"),
             "fileSizeInBytes": random.randint(20_000, 4_000_000)}
            for n, p, b in [("libc.so", "/system/lib64", 64),
                            ("libssl.so", "/system/lib64", 64),
                            ("libcrypto.so", "/system/lib64", 64),
                            ("libc.so", "/system/lib", 32),
                            ("libbinder.so", "/system/lib64", 64)]]
    write(directory, "libraries.txt", envelope("totalLibs", len(libs), "libs", libs, version=version))

    if flavour != "gsi":
        # Exercise all four UI states, not just pass/fail:
        #   verified  - every split found in the log
        #   failed    - no split found (non-Google signer here)
        #   partial   - one split published, one missing. This is the anomaly
        #               the log exists to expose, so the demo must show it.
        #   unchecked - packages the proof run never covered at all
        partial_pkg = "com.google.android.gms"
        skipped = {"com.android.vending", "com.android.settings"}
        proof = {"packages": []}
        for p in pkgs:
            if p["name"] in skipped:
                continue
            splits = p["splits"] or [{"hash": p["hash"]}]
            # Stand-in for "the OEM publishes its own and Google's images":
            # third-party and OEM-signed preloads are the ones absent from the
            # log, which is the realistic shape of a real result.
            verified = active_signers(p)[0] in (certs["google"][0], certs["platform"][0])
            if p["name"] == partial_pkg:
                results = [i == 0 for i in range(len(splits))]
            else:
                results = [verified] * len(splits)
            proof["packages"].append({
                "name": p["name"],
                "versionCode": p["versionCode"],
                "hash": p["hash"],
                "splits": [{**s, "inclusion_proof_verified": v}
                           for s, v in zip(splits, results)],
            })
        write(directory, "packages_with_inclusion_proof_signal.txt",
              json.dumps(proof, indent=2) + "\n")


def main():
    random.seed(1729)
    if shutil.which("openssl") is None:
        sys.exit("openssl is required to generate sample certificates.")

    with tempfile.TemporaryDirectory() as workdir:
        certs = make_certs(workdir)

    root = os.path.normpath(ROOT)
    shutil.rmtree(root, ignore_errors=True)

    build_dir(
        os.path.join(root, "pixel-target"), certs, "oem",
        hardware={"boardName": "orion", "brand": "example", "deviceName": "orion",
                  "hardwareName": "orion", "hash": sha256_of("hw:orion"),
                  "modelName": "Example P7", "oem": "Example Mobility",
                  "productName": "orion_global"},
        build_info={"apiLevel": 34, "bootloaderVersion": "orion-1.2-11223344",
                    "fingerprint": "example/orion_global/orion:14/UP1A.231005.007/11223344:user/release-keys",
                    "kernelVersion": "Linux version 5.15.123-android14 #1 SMP PREEMPT",
                    "locale": "en-US", "radioVersion": "g5300-240101-A-1",
                    "securityPatchLevel": "2024-06-05"})

    build_dir(
        os.path.join(root, "gsi-baseline"), certs, "gsi",
        hardware={"boardName": "generic", "brand": "Android", "deviceName": "generic",
                  "hardwareName": "ranchu", "hash": sha256_of("hw:gsi"),
                  "modelName": "AOSP on ARM64", "oem": "Android",
                  "productName": "aosp_arm64"},
        build_info={"apiLevel": 34, "bootloaderVersion": "unknown",
                    "fingerprint": "Android/aosp_arm64/generic:14/UP1A.231005.007/eng.build:userdebug/test-keys",
                    "kernelVersion": "Linux version 6.1.0-android14 #1 SMP PREEMPT",
                    "locale": "en-US", "radioVersion": "unknown",
                    "securityPatchLevel": "2024-06-05"})

    print(f"Wrote sample observations to {root}")


if __name__ == "__main__":
    main()
