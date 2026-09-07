import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const angular = {
    Injectable: () => target => target,
    Inject: () => () => {},
}
const Platform = { Windows: 'windows', Linux: 'linux' }
const env = {
    USERPROFILE: 'C:\\Users\\example',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    SystemRoot: 'C:\\Windows',
}
const alias = `${env.USERPROFILE}\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe`
const installed = `${env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`
const installedX86 = `${env['ProgramFiles(x86)']}\\PowerShell\\7\\pwsh.exe`
const windowsPowerShell = `${env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

function loadTypeScript (parts, mocks, globals = {}) {
    const filename = path.join(root, ...parts)
    const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            experimentalDecorators: true,
        },
        fileName: filename,
    })
    const exports = {}
    runInNewContext(outputText, {
        exports,
        require: name => {
            if (Object.hasOwn(mocks, name)) {
                return mocks[name]
            }
            throw new Error(`Unexpected require: ${name}`)
        },
        process: { env, arch: 'x64' },
        ...globals,
    }, { filename })
    return exports
}

function createProviders (options = {}) {
    const calls = { registry: [], stat: [], readdir: [], which: [] }
    const config = { store: { terminal: { identification: 'wt' } } }
    const host = { platform: options.platform ?? Platform.Windows }
    const mocks = {
        '@angular/core': angular,
        'tabby-core': { Platform },
        'tabby-local': { ShellProvider: class {} },
        path: path.win32,
        'fs/promises': {
            stat: async file => {
                calls.stat.push(file)
                if (!options.files?.includes(file)) {
                    throw Object.assign(new Error('File not found'), { code: 'ENOENT' })
                }
                return {}
            },
            readdir: async directory => {
                calls.readdir.push(directory)
                return options.directories?.[directory] ?? []
            },
        },
        which: async (name, settings) => {
            assert.equal(settings.nothrow, true)
            calls.which.push(name)
            return options.executables?.[name] ?? null
        },
        '../icons/powershell-core.svg': 'powershell-core-icon',
        '../icons/powershell.svg': 'powershell-icon',
        '../icons/clink.svg': 'clink-icon',
        '../icons/cmd.svg': 'cmd-icon',
    }
    if (!options.noRegistryModule) {
        mocks['windows-native-registry'] = {
            HK: { LM: 'HKLM', CU: 'HKCU' },
            getRegistryValue: (hive, key, value) => {
                calls.registry.push(hive)
                assert.equal(key, 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\pwsh.exe')
                assert.equal(value, '')
                return options.registry?.[hive] ?? null
            },
        }
    }
    const loadShell = name => loadTypeScript(['tabby-electron', 'src', 'shells', `${name}.ts`], mocks)
    mocks['./windowsBase'] = loadShell('windowsBase')
    const { PowerShellCoreShellProvider } = loadShell('powershellCore')
    const { WindowsStockShellsProvider } = loadShell('windowsStock')
    const { WindowsDefaultShellProvider } = loadShell('winDefault')
    const core = new PowerShellCoreShellProvider(host, config)
    const stock = new WindowsStockShellsProvider(host, config, {
        app: { getPath: () => 'C:\\Tabby\\Tabby.exe' },
    })
    const defaultShell = new WindowsDefaultShellProvider(core, {
        provide: async () => options.wsl ?? [],
    }, stock, host, {
        instant: (_key, shell) => `OS default (${shell.name})`,
    })
    return { core, stock, defaultShell, calls }
}

for (const [name, options, expected] of [
    ['HKLM takes precedence', { registry: { HKLM: installed, HKCU: installedX86 } }, installed],
    ['HKCU Store registration', { registry: { HKCU: 'C:\\Store\\pwsh.exe' } }, 'C:\\Store\\pwsh.exe'],
    ['WindowsApps alias with case-insensitive directory fallback', {
        directories: { [path.win32.dirname(alias)]: ['PWSH.EXE'] },
        files: [installed],
    }, alias],
    ['Program Files installation', { files: [installed, installedX86] }, installed],
    ['x86 installation', { files: [installedX86] }, installedX86],
    ['portable PATH installation', { executables: { 'pwsh.exe': 'D:\\Portable\\pwsh.exe' } }, 'D:\\Portable\\pwsh.exe'],
    ['fallback without registry module', { noRegistryModule: true, files: [installed] }, installed],
]) {
    test(`Core detection: ${name}`, async () => {
        const { core, calls } = createProviders(options)
        const shells = await core.provide()
        assert.equal(shells.length, 1)
        assert.equal(shells[0].id, 'powershell-core')
        assert.equal(shells[0].command, expected)
        assert.equal(shells[0].args.join(), '-nologo')
        assert.equal(shells[0].env.WT_SESSION, 0)
        assert.equal(shells[0].shellType, 'powershell')
        if (options.registry) {
            assert.equal(calls.stat.length, 0)
            assert.equal(calls.which.length, 0)
            assert.deepEqual(calls.registry, options.registry.HKLM ? ['HKLM'] : ['HKLM', 'HKCU'])
        }
        if (options.files?.includes(expected)) {
            assert.ok(!calls.readdir.includes(path.win32.dirname(expected)))
        }
    })
}

test('Missing PowerShell and non-Windows hosts produce no Core shell', async () => {
    assert.equal((await createProviders().core.provide()).length, 0)
    const { core, stock, defaultShell, calls } = createProviders({ platform: Platform.Linux })
    for (const provider of [core, stock, defaultShell]) {
        assert.equal((await provider.provide()).length, 0)
    }
    assert.ok(Object.values(calls).every(value => value.length === 0))
})

test('Stock shells retain Windows PowerShell without detecting pwsh', async () => {
    const { stock, calls } = createProviders({ files: [windowsPowerShell, installed] })
    const shells = await stock.provide()
    assert.equal(shells.map(shell => shell.id).join(), 'clink,cmd,powershell')
    assert.equal(shells[2].command, windowsPowerShell)
    assert.deepEqual(calls.stat, [windowsPowerShell])
    assert.equal(calls.registry.length, 0)
    assert.equal(calls.which.length, 0)
})

test('Core is the only modern profile, with a separate default shortcut', async () => {
    const { core, stock, defaultShell } = createProviders({
        registry: { HKCU: installed },
        files: [installed, windowsPowerShell],
    })
    const shells = (await Promise.all([defaultShell, stock, core].map(provider => provider.provide()))).flat()
    assert.equal(shells.map(shell => shell.id).join(), 'default,clink,cmd,powershell,powershell-core')
    assert.equal(shells[0].command, installed)
    assert.equal(shells[0].name, 'OS default (PowerShell Core)')
})

test('Default uses Core fallback detection before WSL, then WSL or stock if Core is absent', async () => {
    const wsl = [{ id: 'wsl', name: 'WSL', command: 'wsl.exe' }]
    for (const [options, expected] of [
        [{ files: [installed], wsl }, installed],
        [{ wsl }, 'wsl.exe'],
        [{ files: [windowsPowerShell] }, windowsPowerShell],
        [{}, 'cmd.exe'],
    ]) {
        const shells = await createProviders(options).defaultShell.provide()
        assert.equal(shells[0].id, 'default')
        assert.equal(shells[0].command, expected)
    }
})

function migrate (config) {
    const { ConfigService } = loadTypeScript(['tabby-core', 'src', 'services', 'config.service.ts'], {
        '@angular/core': angular,
        'clone-deep': {},
        'deep-equal': {},
        uuid: {},
        'js-yaml': {},
        rxjs: {},
        '@ngx-translate/core': {},
        '../api/configProvider': {},
        '../api/platform': {},
        '../api/hostApp': {},
        './vault.service': {},
        '../utils': {},
        deepmerge: {},
    })
    ConfigService.prototype.migrate.call({}, config)
}

test('Legacy pwsh preferences migrate without losing Core shortcuts or custom commands', () => {
    const config = {
        version: 8,
        terminal: { profile: 'local:pwsh' },
        hotkeys: { profile: {
            'local:pwsh': ['Ctrl-P', ['Ctrl-K', 'P']],
            'local:powershell-core': 'Ctrl-Shift-P',
            'local:powershell': ['Alt-P'],
        } },
        profileBlacklist: ['local:pwsh', 'local:powershell-core', 'local:powershell'],
        profiles: [{ id: 'local:custom:example', options: { command: 'local:pwsh' } }],
    }
    migrate(config)
    assert.equal(config.version, 9)
    assert.equal(config.terminal.profile, 'local:powershell-core')
    assert.ok(!Object.hasOwn(config.hotkeys.profile, 'local:pwsh'))
    assert.equal(JSON.stringify(config.hotkeys.profile['local:powershell-core']),
        JSON.stringify(['Ctrl-Shift-P', 'Ctrl-P', ['Ctrl-K', 'P']]))
    assert.equal(config.hotkeys.profile['local:powershell'].join(), 'Alt-P')
    assert.equal(config.profileBlacklist.join(), 'local:powershell-core,local:powershell')
    assert.equal(config.profiles[0].options.command, 'local:pwsh')
    const migrated = JSON.stringify(config)
    migrate(config)
    assert.equal(JSON.stringify(config), migrated)
})

test('Migration handles missing settings, legacy string hotkeys and unrelated defaults', () => {
    for (const profile of [undefined, 'local:default', 'local:powershell', 'local:powershell-core']) {
        const config = { version: 8, terminal: { profile } }
        migrate(config)
        assert.equal(config.terminal.profile, profile)
        assert.equal(config.version, 9)
    }
    const config = { version: 8, hotkeys: { profile: { 'local:pwsh': 'Ctrl-P' } } }
    migrate(config)
    assert.equal(config.hotkeys.profile['local:powershell-core'].join(), 'Ctrl-P')
    const empty = { version: 8 }
    migrate(empty)
    assert.deepEqual(empty, { version: 9 })
})
