//-----------------------------------------------------------------------------
// vscode-catch2-test-adapter was written by Mate Pek, and is placed in the
// public domain. The author hereby disclaims copyright to this source code.

import * as path from 'path';
import { inspect } from 'util';
import * as vscode from 'vscode';
import {
  TestInfo,
  TestSuiteInfo,
  TestEvent,
  TestLoadFinishedEvent,
  TestLoadStartedEvent,
  TestRunFinishedEvent,
  TestRunStartedEvent,
  TestSuiteEvent,
} from 'vscode-test-adapter-api';
import * as api from 'vscode-test-adapter-api';
import * as util from 'vscode-test-adapter-util';

import { RootTestSuiteInfo } from './RootTestSuiteInfo';
import { resolveVariables } from './Helpers';
import { TaskQueue } from './TaskQueue';
import { TestExecutableInfo } from './TestExecutableInfo';
import { SharedVariables } from './SharedVariables';
import { AbstractTestInfo } from './AbstractTestInfo';

export class TestAdapter implements api.TestAdapter, vscode.Disposable {
  private readonly _log: util.Log;
  private readonly _testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
  private readonly _testStatesEmitter = new vscode.EventEmitter<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  >();
  private readonly _autorunEmitter = new vscode.EventEmitter<void>();

  private readonly _variableToValue: [string, string][] = [
    ['${workspaceDirectory}', this.workspaceFolder.uri.fsPath],
    ['${workspaceFolder}', this.workspaceFolder.uri.fsPath],
    ['${workspaceName}', this.workspaceFolder.name],
  ];

  // because we always want to return with the current rootSuite suite
  private readonly _loadWithTaskEmitter = new vscode.EventEmitter<() => void | PromiseLike<void>>();

  private readonly _sendTestEventEmitter = new vscode.EventEmitter<TestEvent[]>();

  private readonly _mainTaskQueue = new TaskQueue([], 'TestAdapter');
  private readonly _disposables: vscode.Disposable[] = [];

  private readonly _shared: SharedVariables;
  private _rootSuite: RootTestSuiteInfo;

  public constructor(public readonly workspaceFolder: vscode.WorkspaceFolder) {
    this._log = new util.Log(
      'catch2TestExplorer',
      this.workspaceFolder,
      'Test Explorer: ' + this.workspaceFolder.name,
      { showProxy: true, depth: 3 },
    );

    this._log.info('info:', this.workspaceFolder, process.platform, process.version, process.versions, vscode.version);

    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this._variableToValue[2][1] = this.workspaceFolder.name;
      }),
    );

    this._disposables.push(this._testsEmitter);
    this._disposables.push(this._testStatesEmitter);
    this._disposables.push(this._autorunEmitter);

    this._disposables.push(this._loadWithTaskEmitter);
    this._disposables.push(
      this._loadWithTaskEmitter.event((task: () => void | PromiseLike<void>) => {
        this._mainTaskQueue.then(() => {
          this._testsEmitter.fire({ type: 'started' });
          return Promise.resolve()
            .then(task)
            .then(
              () => {
                this._testsEmitter.fire({
                  type: 'finished',
                  suite: this._rootSuite.children.length > 0 ? this._rootSuite : undefined,
                });
              },
              (reason: Error) => {
                this._log.error(__filename, reason);
                debugger;
                this._testsEmitter.fire({
                  type: 'finished',
                  errorMessage: inspect(reason),
                  suite: this._rootSuite.children.length > 0 ? this._rootSuite : undefined,
                });
              },
            );
        });
      }),
    );

    this._disposables.push(this._sendTestEventEmitter);
    this._disposables.push(
      this._sendTestEventEmitter.event((testEvents: TestEvent[]) => {
        this._mainTaskQueue.then(() => {
          for (let i = 0; i < testEvents.length; ++i) {
            const id: string =
              typeof testEvents[i].test === 'string'
                ? (testEvents[i].test as string)
                : (testEvents[i].test as TestInfo).id;
            const route = this._rootSuite.findRouteToTestById(id);

            if (route !== undefined && route.length > 1) {
              this._testStatesEmitter.fire({ type: 'started', tests: [id] });

              for (let j = 0; j < route.length - 1; ++j)
                this._testStatesEmitter.fire({ type: 'suite', suite: route[j] as TestSuiteInfo, state: 'running' });

              this._testStatesEmitter.fire({ type: 'test', test: testEvents[i].test, state: 'running' });
              this._testStatesEmitter.fire(testEvents[i]);

              for (let j = route.length - 2; j >= 0; --j)
                this._testStatesEmitter.fire({ type: 'suite', suite: route[j] as TestSuiteInfo, state: 'completed' });

              this._testStatesEmitter.fire({ type: 'finished' });
            } else {
              this._log.error('sendTestEventEmitter.event', testEvents[i], route, this._rootSuite);
            }
          }
        });
      }),
    );

    const config = this._getConfiguration();

    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration(configChange => {
        if (
          configChange.affectsConfiguration('catch2TestExplorer.defaultEnv', this.workspaceFolder.uri) ||
          configChange.affectsConfiguration('catch2TestExplorer.defaultCwd', this.workspaceFolder.uri) ||
          configChange.affectsConfiguration('catch2TestExplorer.executables', this.workspaceFolder.uri)
        ) {
          this._shared.defaultEnv = this._getDefaultEnvironmentVariables(config);
          this.load();
        }
      }),
    );

    this._shared = new SharedVariables(
      this._log,
      this.workspaceFolder,
      this._testStatesEmitter,
      this._loadWithTaskEmitter,
      this._sendTestEventEmitter,
      this._getEnableSourceDecoration(config),
      this._getDefaultRngSeed(config),
      this._getDefaultExecWatchTimeout(config),
      this._getDefaultExecRunningTimeout(config),
      this._getDefaultNoThrow(config),
      this._getDefaultEnvironmentVariables(config),
    );

    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration(configChange => {
        if (configChange.affectsConfiguration('catch2TestExplorer.enableSourceDecoration', this.workspaceFolder.uri)) {
          this._shared.isEnabledSourceDecoration = this._getEnableSourceDecoration(this._getConfiguration());
        }
        if (configChange.affectsConfiguration('catch2TestExplorer.defaultRngSeed', this.workspaceFolder.uri)) {
          this._shared.rngSeed = this._getDefaultRngSeed(this._getConfiguration());
          this._autorunEmitter.fire();
        }
        if (configChange.affectsConfiguration('catch2TestExplorer.defaultWatchTimeoutSec', this.workspaceFolder.uri)) {
          this._shared.execWatchTimeout = this._getDefaultExecWatchTimeout(this._getConfiguration());
        }
        if (
          configChange.affectsConfiguration('catch2TestExplorer.defaultRunningTimeoutSec', this.workspaceFolder.uri)
        ) {
          this._shared.setExecRunningTimeout(this._getDefaultExecRunningTimeout(this._getConfiguration()));
        }
        if (configChange.affectsConfiguration('catch2TestExplorer.defaultNoThrow', this.workspaceFolder.uri)) {
          this._shared.isNoThrow = this._getDefaultNoThrow(this._getConfiguration());
        }
        if (configChange.affectsConfiguration('catch2TestExplorer.workerMaxNumber', this.workspaceFolder.uri)) {
          this._rootSuite.workerMaxNumber = this._getWorkerMaxNumber(this._getConfiguration());
        }
      }),
    );

    this._rootSuite = new RootTestSuiteInfo(this._shared, 1);
  }

  public dispose(): void {
    this._log.info('dispose: ', this.workspaceFolder);

    this._disposables.forEach(d => {
      try {
        d.dispose();
      } catch (e) {
        this._log.error('dispose', e, d);
      }
    });

    try {
      this._shared.dispose();
    } catch (e) {
      this._log.error('dispose', e, this._shared);
    }

    try {
      this._rootSuite.dispose();
    } catch (e) {
      this._log.error('dispose', e, this._rootSuite);
    }

    try {
      this._log.dispose();
    } catch (e) {
      this._log.error('dispose', e, this._log);
    }
  }

  public get testStates(): vscode.Event<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent> {
    return this._testStatesEmitter.event;
  }

  public get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
    return this._testsEmitter.event;
  }

  public get autorun(): vscode.Event<void> {
    return this._autorunEmitter.event;
  }

  public load(): Promise<void> {
    this._log.info('load called');
    this._mainTaskQueue.size > 0 && this.cancel();

    const config = this._getConfiguration();

    this._rootSuite.dispose();

    this._rootSuite = new RootTestSuiteInfo(this._shared, this._getWorkerMaxNumber(config));

    return this._mainTaskQueue.then(() => {
      this._log.info('load started');

      this._testsEmitter.fire({ type: 'started' });

      return this._rootSuite.load(this._getExecutables(config, this._rootSuite)).then(
        () => {
          this._log.info('load finished', this._rootSuite.children.length);

          this._testsEmitter.fire({
            type: 'finished',
            suite: this._rootSuite.children.length > 0 ? this._rootSuite : undefined,
          });
        },
        (e: Error) => {
          this._log.info('load finished with error:', e);

          this._testsEmitter.fire({
            type: 'finished',
            suite: undefined,
            errorMessage: inspect(e),
          });
        },
      );
    });
  }

  public cancel(): void {
    this._rootSuite.cancel();
  }

  public run(tests: string[]): Promise<void> {
    if (this._mainTaskQueue.size > 0) {
      this._log.info(__filename + '. Run is busy');
    }

    return this._mainTaskQueue.then(() => {
      return this._rootSuite.run(tests).catch((reason: Error) => {
        this._log.error(reason);
      });
    });
  }

  public debug(tests: string[]): Promise<void> {
    if (this._mainTaskQueue.size > 0) {
      this._log.info(__filename + '. Debug is busy');
      throw Error('The adapter is busy. Try it again a bit later.');
    }

    this._log.info('Debugging');

    if (tests.length !== 1) {
      this._log.error('unsupported test count: ', tests);
      throw Error('Unsupported input. Contact');
    }

    const route = this._rootSuite.findRouteToTestById(tests[0]);
    if (route === undefined) {
      this._log.warn('route === undefined');
      throw Error('Not existing test id.');
    } else if (route.length == 0) {
      this._log.error('route.length == 0');
      throw Error('Unexpected error.');
    } else if (route[route.length - 1].type !== 'test') {
      this._log.error("route[route.length-1].type !== 'test'");
      throw Error('Unexpected error.');
    }

    const testInfo = route[route.length - 1] as AbstractTestInfo;
    route.pop();
    const suiteLabels = route.map(s => s.label).join(' ➡️ ');

    this._log.info('testInfo: ', testInfo, tests);

    const config = this._getConfiguration();

    const template = this._getDebugConfigurationTemplate(config);

    const argsArray = testInfo.getDebugParams(this._getDebugBreakOnFailure(config));

    const debugConfig = resolveVariables(template, [
      ...this._variableToValue,
      ['${suitelabel}', suiteLabels],
      ['${suiteLabel}', suiteLabels],
      ['${label}', testInfo.label],
      ['${exec}', testInfo.execPath],
      ['${args}', argsArray],
      ['${argsStr}', '"' + argsArray.join('" "') + '"'],
      ['${cwd}', testInfo.execOptions.cwd!],
      ['${envObj}', testInfo.execOptions.env!],
    ]);

    this._log.info('Debug: resolved catch2TestExplorer.debugConfigTemplate:', debugConfig);

    return this._mainTaskQueue.then(() => {
      return vscode.debug
        .startDebugging(this.workspaceFolder, debugConfig)
        .then((debugSessionStarted: boolean) => {
          const currentSession = vscode.debug.activeDebugSession;

          if (!debugSessionStarted || !currentSession) {
            return Promise.reject(
              'Failed starting the debug session - aborting. Maybe something wrong with "catch2TestExplorer.debugConfigTemplate"; ' +
                +debugSessionStarted +
                '; ' +
                currentSession,
            );
          }

          this._log.info('debugSessionStarted');

          return new Promise<void>(resolve => {
            const subscription = vscode.debug.onDidTerminateDebugSession(session => {
              if (currentSession != session) return;
              this._log.info('Debug session ended.');
              resolve();
              subscription.dispose();
            });
          });
        })
        .then(undefined, (reason: Error) => {
          this._log.error(reason);
          throw reason;
        });
    });
  }

  private _getDebugConfigurationTemplate(config: vscode.WorkspaceConfiguration): vscode.DebugConfiguration {
    const templateFromConfig = config.get<object | null>('debugConfigTemplate', null);

    const template: vscode.DebugConfiguration = Object.assign(
      {
        name: '${label} (${suiteLabel})',
        request: 'launch',
        type: 'cppdbg',
      },
      templateFromConfig ? templateFromConfig : {},
    );

    if (templateFromConfig === null) {
      if (vscode.extensions.getExtension('vadimcn.vscode-lldb')) {
        Object.assign(template, {
          type: 'cppdbg',
          MIMode: 'lldb',
          program: '${exec}',
          args: '${args}',
          cwd: '${cwd}',
          env: '${envObj}',
        });
      } else if (vscode.extensions.getExtension('webfreak.debug')) {
        Object.assign(template, {
          type: 'gdb',
          target: '${exec}',
          arguments: '${argsStr}',
          cwd: '${cwd}',
          env: '${envObj}',
          valuesFormatting: 'prettyPrinters',
        });

        if (process.platform === 'darwin') {
          template.type = 'lldb-mi';
          // Note: for LLDB you need to have lldb-mi in your PATH
          // If you are on OS X you can add lldb-mi to your path using ln -s /Applications/Xcode.app/Contents/Developer/usr/bin/lldb-mi /usr/local/bin/lldb-mi if you have Xcode.
          template.lldbmipath = '/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-mi';
        }
      } else if (vscode.extensions.getExtension('ms-vscode.cpptools')) {
        // documentation says debug"environment" = [{...}] but that doesn't work
        Object.assign(template, {
          type: 'cppvsdbg',
          linux: { type: 'cppdbg', MIMode: 'gdb' },
          osx: { type: 'cppdbg', MIMode: 'lldb' },
          windows: { type: 'cppvsdbg' },
          program: '${exec}',
          args: '${args}',
          cwd: '${cwd}',
          env: '${envObj}',
        });
      } else {
        throw Error(
          "For debugging 'catch2TestExplorer.debugConfigTemplate' should be set: https://github.com/matepek/vscode-catch2-test-adapter#or-user-can-manually-fill-it",
        );
      }
    }

    return template;
  }

  private _getConfiguration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('catch2TestExplorer', this.workspaceFolder.uri);
  }

  private _getDebugBreakOnFailure(config: vscode.WorkspaceConfiguration): boolean {
    return config.get<boolean>('debugBreakOnFailure', true);
  }

  private _getDefaultNoThrow(config: vscode.WorkspaceConfiguration): boolean {
    return config.get<boolean>('defaultNoThrow', false);
  }

  private _getDefaultCwd(config: vscode.WorkspaceConfiguration): string {
    const dirname = this.workspaceFolder.uri.fsPath;
    const cwd = resolveVariables(config.get<string>('defaultCwd', dirname), this._variableToValue);
    if (path.isAbsolute(cwd)) {
      return cwd;
    } else {
      return path.resolve(this.workspaceFolder.uri.fsPath, cwd);
    }
  }

  private _getDefaultRngSeed(config: vscode.WorkspaceConfiguration): string | number | null {
    return config.get<null | string | number>('defaultRngSeed', null);
  }

  private _getWorkerMaxNumber(config: vscode.WorkspaceConfiguration): number {
    const res = Math.max(1, config.get<number>('workerMaxNumber', 1));
    this._log.info('workerMaxNumber:', res);
    return res;
  }

  private _getDefaultExecWatchTimeout(config: vscode.WorkspaceConfiguration): number {
    const res = config.get<number>('defaultWatchTimeoutSec', 10) * 1000;
    this._log.info('defaultWatchTimeoutSec:', res);
    return res;
  }

  private _getDefaultExecRunningTimeout(config: vscode.WorkspaceConfiguration): null | number {
    const r = config.get<null | number>('defaultRunningTimeoutSec', null);
    return r !== null && r > 0 ? r * 1000 : null;
  }

  private _getDefaultEnvironmentVariables(config: vscode.WorkspaceConfiguration): { [prop: string]: string } {
    return config.get('defaultEnv', {});
  }

  private _getEnableSourceDecoration(config: vscode.WorkspaceConfiguration): boolean {
    return config.get<boolean>('enableSourceDecoration', true);
  }

  private _getExecutables(config: vscode.WorkspaceConfiguration, rootSuite: RootTestSuiteInfo): TestExecutableInfo[] {
    const globalWorkingDirectory = this._getDefaultCwd(config);

    let executables: TestExecutableInfo[] = [];

    const configExecs:
      | undefined
      | string
      | string[]
      | { [prop: string]: string }
      | ({ [prop: string]: string } | string)[] = config.get('executables');

    this._log.info('executables:', configExecs);

    const createFromObject = (obj: { [prop: string]: string }): TestExecutableInfo => {
      const name: string | undefined = typeof obj.name === 'string' ? obj.name : undefined;

      let pattern = '';
      if (typeof obj.pattern == 'string') pattern = obj.pattern;
      else if (typeof obj.path == 'string') pattern = obj.path;
      else throw Error('Error: pattern property is required.');

      const cwd: string = typeof obj.cwd === 'string' ? obj.cwd : globalWorkingDirectory;

      const env: { [prop: string]: string } | undefined = typeof obj.env === 'object' ? obj.env : undefined;

      return new TestExecutableInfo(this._shared, rootSuite, name, pattern, cwd, env, this._variableToValue);
    };

    if (typeof configExecs === 'string') {
      if (configExecs.length == 0) return [];
      executables.push(
        new TestExecutableInfo(
          this._shared,
          rootSuite,
          undefined,
          configExecs,
          globalWorkingDirectory,
          undefined,
          this._variableToValue,
        ),
      );
    } else if (Array.isArray(configExecs)) {
      for (var i = 0; i < configExecs.length; ++i) {
        const configExec = configExecs[i];
        if (typeof configExec === 'string') {
          const configExecsName = String(configExec);
          if (configExecsName.length > 0) {
            executables.push(
              new TestExecutableInfo(
                this._shared,
                rootSuite,
                undefined,
                configExecsName,
                globalWorkingDirectory,
                undefined,
                this._variableToValue,
              ),
            );
          }
        } else if (typeof configExec === 'object') {
          try {
            executables.push(createFromObject(configExec));
          } catch (e) {
            this._log.warn(e, configExec);
          }
        } else {
          this._log.error('_getExecutables', configExec, i);
        }
      }
    } else if (typeof configExecs === 'object') {
      try {
        executables.push(createFromObject(configExecs));
      } catch (e) {
        this._log.warn(e, configExecs);
      }
    } else {
      this._log.error("executables couldn't be recognised:", executables);
      throw new Error('Config error: wrong type: executables');
    }

    return executables;
  }
}
