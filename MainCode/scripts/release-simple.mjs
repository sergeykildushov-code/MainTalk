/**
 * SPDX-FileCopyrightText: 2023 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/// <reference types="zx" />
/* eslint-disable no-undef */

const fs = require("fs")
const path = require("path")
const packageJson = require("../package.json")

const TALK_PATH = "./spreed/"

$.quiet = true

function exit(message, code) {
	echo(message)
	process.exit(code)
}

function help() {
	echo`Prepare release packages for Talk Desktop with Talk in ${TALK_PATH}

	Usage: npm run release:package -- --linux --mac --windows --version=v20.0.0
	If no platform is specified, the current platform will be used.
	If no version is specified, the stable version from package.json will be used.

	Args:
	--help - show help
	--version - Optionally a specific Talk version/branch to build with, for example, v20.0.0-rc.1 or main. Default is package.json/talk.
	--channel [CHANNEL] - Release channel: stable, beta, or dev. Default is stable.
	--windows - build Windows package
	--linux - build Linux package
	--mac - build macOS package using universal architecture (recommended)
	--mac-x64 - build macOS package using x64 architecture
	--mac-arm64 - build macOS package using arm64 architecture
	--skip-install - skip installing dependencies in both repositories (use for debug only)
	--skip-check - skip checking for uncommitted changes in talk-desktop (use for debug only)
`
	exit("", 0)
}

async function prepareRelease() {
	const CHANNEL = process.env.CHANNEL || argv.channel || "stable"
	const TALK_VERSION = argv.version || packageJson.talk[CHANNEL]

	if (!argv.windows && !argv.linux && !argv.mac && !argv["mac-x64"] && !argv["mac-arm64"]) {
		const platform = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux"
		argv[platform] = true
	}

	echo`Packaging Nextcloud Talk v${packageJson.version} with Talk ${TALK_VERSION}...`

	$.env.TALK_PATH = TALK_PATH
	$.env.CHANNEL = CHANNEL

	// --- Windows build ---
	if (argv.windows) {
		await spinner("Package Windows", () => $`npm run build:windows && npm run package:windows`)

		const outDirExe = "./out/make/squirrel.windows/x64"
		const outDirMsi = "./out/make/wix/msi/x64" // стандартный путь electron-forge для MSI
		const exeName = `Nextcloud.Talk-${packageJson.version}-windows-x64.exe`
		const msiName = `Nextcloud.Talk-${packageJson.version}-windows-x64.msi`

		// === обработка exe ===
		if (fs.existsSync(outDirExe)) {
			const generatedExe = fs.readdirSync(outDirExe).find(f => f.endsWith(".exe"))
			if (generatedExe) {
				const oldPath = path.join(outDirExe, generatedExe)
				const newPath = path.join(outDirExe, exeName)
				fs.renameSync(oldPath, newPath)
				echo`✅ EXE готов: ${newPath}`
			} else {
				echo`⚠️ EXE не найден в ${outDirExe}`
			}
		}

		// === обработка msi ===
		if (fs.existsSync(outDirMsi)) {
			const generatedMsi = fs.readdirSync(outDirMsi).find(f => f.endsWith(".msi"))
			if (generatedMsi) {
				const oldPath = path.join(outDirMsi, generatedMsi)
				const newPath = path.join(outDirMsi, msiName)
				fs.renameSync(oldPath, newPath)
				echo`✅ MSI готов: ${newPath}`
			} else {
				echo`⚠️ MSI не найден в ${outDirMsi}`
			}
		} else {
			echo`⚠️ Папка MSI не найдена (${outDirMsi}), возможно, нужно включить wix в targets.`
		}
	}

	echo`🎉 Done. See output in ./out/make/`
}

if (os.platform() === "win32") {
	usePwsh()
}

if (argv.help) {
	help()
}

await prepareRelease()
