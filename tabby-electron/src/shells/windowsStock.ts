import * as path from 'path'
import * as fs from 'fs/promises'
import * as which from 'which'
import { Injectable } from '@angular/core'
import { HostAppService, Platform, ConfigService } from 'tabby-core'
import { ElectronService } from '../services/electron.service'

import { Shell } from 'tabby-local'
import { WindowsBaseShellProvider } from './windowsBase'

/** @hidden */
@Injectable()
export class WindowsStockShellsProvider extends WindowsBaseShellProvider {
    constructor (
        hostApp: HostAppService,
        config: ConfigService,
        private electron: ElectronService,
    ) {
        super(hostApp, config)
    }

    async provide (): Promise<Shell[]> {
        if (this.hostApp.platform !== Platform.Windows) {
            return []
        }

        let clinkPath = path.join(
            path.dirname(this.electron.app.getPath('exe')),
            'resources',
            'extras',
            'clink',
            `clink_${process.arch}.exe`,
        )

        if (process.env.TABBY_DEV) {
            clinkPath = path.join(
                path.dirname(this.electron.app.getPath('exe')),
                '..', '..', '..',
                'extras',
                'clink',
                `clink_${process.arch}.exe`,
            )
        }
        const shells: Shell[] = [
            {
                id: 'clink',
                name: 'CMD (clink)',
                command: 'cmd.exe',
                args: ['/k', clinkPath, 'inject'],
                env: {
                    // Tell clink not to emulate ANSI handling
                    WT_SESSION: '0',
                },
                icon: require('../icons/clink.svg'),
                shellType: 'cmd',
            },
            {
                id: 'cmd',
                name: 'CMD (stock)',
                command: 'cmd.exe',
                env: {},
                icon: require('../icons/cmd.svg'),
                shellType: 'cmd',
            },
        ]

        const powershellPath = await this.findExecutable([
            `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
            `${process.env.SystemRoot}\\System32\\powershell.exe`,
        ], 'powershell.exe')
        if (powershellPath) {
            shells.push({
                id: 'powershell',
                name: 'PowerShell',
                command: powershellPath,
                args: ['-nologo'],
                icon: require('../icons/powershell.svg'),
                env: this.getEnvironment(),
                shellType: 'powershell',
            })
        }

        const pwshPath = await this.findExecutable([
            `${process.env.USERPROFILE}\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe`,
            `${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`,
            `${process.env['ProgramFiles(x86)']}\\PowerShell\\7\\pwsh.exe`,
        ], 'pwsh.exe')
        if (pwshPath) {
            shells.push({
                id: 'pwsh',
                name: 'PowerShell 7',
                command: pwshPath,
                args: ['-nologo'],
                icon: require('../icons/powershell-core.svg'),
                env: this.getEnvironment(),
                shellType: 'powershell',
            })
        }

        return shells
    }

    /**
     * Looks for an executable at the given well-known paths first (fast),
     * falling back to a PATH search by `name` (slower) if none are found.
     */
    private async findExecutable (wellKnownPaths: string[], name: string): Promise<string|null> {
        for (const execPath of wellKnownPaths) {
            if (await this.fileExists(execPath)) {
                return execPath
            }
        }
        return which(name, { nothrow: true })
    }

    /**
     * Checks whether a file exists, working around a Node.js limitation on
     * Windows App Execution Alias reparse points (e.g. `pwsh.exe` when
     * PowerShell 7 is installed from the Microsoft Store): `fs.stat` throws
     * for these even though the file is runnable. `fs.stat` is tried first
     * since it's fast and works for regular files; if it fails, the parent
     * directory is listed as a fallback, which doesn't require resolving
     * the reparse target.
     */
    private async fileExists (filePath: string): Promise<boolean> {
        try {
            await fs.stat(filePath)
            return true
        } catch { }
        try {
            const targetName = path.basename(filePath).toLowerCase()
            const names = await fs.readdir(path.dirname(filePath))
            return names.some(name => name.toLowerCase() === targetName)
        } catch {
            return false
        }
    }
}
