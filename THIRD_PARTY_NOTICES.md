# Third-party notices

MyHarness itself is licensed under Apache-2.0. That license applies to the
MyHarness work that its contributors are authorized to license; it does not
relicense third-party or inherited material.

The repository retains third-party notices in the location closest to the
material they cover:

- **pi-mono (MIT License, Copyright (c) 2025 Mario Zechner)**

  MyHarness was originally derived from pi-mono
  (https://github.com/badlogic/pi-mono) and has since been substantially
  rewritten. Portions of `packages/agent`, `packages/ai`,
  `packages/coding-agent`, several files under `scripts/`, and the images
  `doom-extension.png`, `exy.png` and `tree-view.png` under
  `packages/coding-agent/docs/images/` originate from pi-mono.

  ```text
  MIT License

  Copyright (c) 2025 Mario Zechner

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  ```

- `packages/coding-agent/src/utils/ansi.ts` retains the ansi-regex and
  strip-ansi MIT attribution from Sindre Sorhus.
- `packages/coding-agent/src/exports/html/vendor/marked.min.js` retains the
  MarkedJS and Christopher Jeffrey notices, and `highlight.min.js` retains its
  BSD-3-Clause notice.
- `packages/coding-agent/web/vendor/` contains the Web UI runtime libraries
  Preact (MIT, Jason Miller; `LICENSE.preact`) and htm (Apache-2.0, Jason
  Miller; `LICENSE.htm`) as unmodified ES module builds, except that the bare
  `preact` import in `preact-hooks.js` is rewritten to a relative path so the
  page needs no import map. The Web UI also loads the `marked` and
  `highlight.js` files listed above. The same directory contains xterm.js
  6.0.0 (`xterm.js`, `xterm.css`; MIT, The xterm.js authors, SourceLair
  Private Company and Christopher Jeffrey; `LICENSE.xterm`) and its fit addon
  0.11.0 (`xterm-addon-fit.js`; MIT, The xterm.js authors;
  `LICENSE.xterm-addon-fit`), which draw the Terminal panel. They are the
  packages' ES module builds and stylesheet, unmodified except that the
  trailing source-map reference of the two scripts is removed (the maps are
  not shipped).
- `packages/coding-agent/web/js/icons.js` contains SVG path data copied from
  Heroicons 2.2.0 outline icons (MIT, Tailwind Labs, Inc.; the license text is
  `packages/coding-agent/web/vendor/LICENSE.heroicons`). Only the path strings
  are copied (no Heroicons package or file is shipped); the glyphs that
  Heroicons does not have are MyHarness drawings.
- The Terminal panel's pseudo terminal is the optional npm dependency
  `@lydell/node-pty` (MIT; Christopher Jeffrey, Daniel Imms and Microsoft
  Corporation), a repackaging of node-pty with prebuilt binaries. It is
  installed from the npm registry and not copied into this source tree.
- On Windows, the job objects that hold a command's process tree are created
  through the optional npm dependency `koffi` 3.3.3 (MIT, Niels Martignène), a
  foreign function interface whose prebuilt binaries come from its
  `@koromix/koffi-*` packages. The desktop host uses the same package for its
  own job object. It is installed from the npm registry and not copied into
  this source tree.
- The desktop host's dark mode for websites runs the npm package
  `darkreader` 4.9.133 (MIT, Dark Reader Ltd.) unmodified in each
  website tab. It is installed from the npm registry, not copied into this
  source tree; the desktop build copies its `darkreader.js`, `LICENSE` and
  `package.json` into the packaged app (`runtime/node_modules/darkreader`).
- The phone link's direct connection over the internet
  (`packages/coding-agent/src/modes/web/phone-link/remote.ts`) uses the npm
  package `werift` 0.25.2 (MIT, shinyoshiaki), a WebRTC implementation in
  TypeScript. It is installed from the npm registry, unmodified, and not
  copied into this source tree. Among the packages it brings, `mediabunny`
  (MPL-2.0, Vanilagy; source at https://github.com/Vanilagy/mediabunny) is
  shipped unmodified with its license in its own folder; `asn1js` is
  BSD-3-Clause (Peculiar Ventures), `reflect-metadata` is Apache-2.0
  (Microsoft Corporation), `tweetnacl` is Unlicense, and the rest are MIT or
  0BSD.
- The Android app (`packages/mobile`) is built with Gradle from libraries
  that are downloaded from Google Maven and Maven Central at build time and
  compiled into the APK; none is copied into this source tree: AndroidX Core
  1.19.1, Activity 1.13.0 and WebKit 1.18.0 (Apache-2.0, The Android Open
  Source Project), OkHttp 5.5.1 with Okio (Apache-2.0, Square, Inc.) and the
  Kotlin standard library they need (Apache-2.0, JetBrains s.r.o. and Kotlin
  contributors), and ZXing Android Embedded 4.3.0 (Apache-2.0, JourneyApps)
  with ZXing core (Apache-2.0, ZXing authors), which reads the pairing QR
  code. The app's page ships the same Preact, htm, marked and highlight.js
  files as the Web UI (with `LICENSE.preact`, `LICENSE.htm` and
  `LICENSE.heroicons` copied beside them), and its `core.bundle.js` is an
  esbuild bundle of this repository's agent and provider code together with
  the npm packages those import: `openai` (Apache-2.0, OpenAI),
  `@anthropic-ai/sdk` (MIT, Anthropic, PBC), `@google/genai` (Apache-2.0,
  Google LLC), `typebox` (MIT, sinclairzx81), `partial-json` (MIT, Muspi
  Merol), `p-retry` (MIT, Sindre Sorhus) and `retry` (MIT, Tim Koschützki
  and Felix Geisendörfer).
- The QR code shown for phone pairing (`packages/coding-agent/web/js/qr-code.js`)
  is MyHarness's own implementation of ISO/IEC 18004; no QR library is used.
  "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
- `packages/agent/src/harness/compaction/CODEX-NOTICE.md` and
  `CODEX-LICENSE` identify the adapted OpenAI Codex source and its Apache-2.0
  terms.
- The optional Windows Code Intelligence catalog and its redistribution files
  are recorded in
  `packages/coding-agent/code-intelligence/DEPENDENCY-MANIFEST.json` and
  `packages/coding-agent/code-intelligence/licenses/`. This includes the
  component-specific MIT, Apache/LLVM, BSD, EPL, Microsoft, and other notices.

The large Code Intelligence archives are not tracked in this source tree. The
manifest at `packages/coding-agent/code-intelligence/runtime-manifest.json`
records the current `releaseTag` together with each archive's `sizeBytes` and
`sha256`. The files above are still kept so that a release archive can be
accompanied by the notices required by its actual contents.

Package names, compatibility aliases, inherited package authors, and old
changelog entries are provenance or compatibility information; they are not
claims that MyHarness owns the corresponding third-party work.
