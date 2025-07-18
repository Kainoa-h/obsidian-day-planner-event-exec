import {
  MarkdownView,
  Notice,
  Plugin,
  WorkspaceLeaf,
  type MarkdownFileInfo,
} from "obsidian";
import { } from "obsidian-daily-notes-interface";
import { getAPI } from "obsidian-dataview";
import { fromStore, get, writable, type Writable } from "svelte/store";
import { isInstanceOf, isNotVoid } from "typed-assert";

import {
  errorContextKey,
  obsidianContextKey,
  viewTypeReleaseNotes,
  viewTypeTimeline,
  viewTypeMultiDay,
  icalRefreshIntervalMillis,
} from "./constants";
import { createUpdateHandler } from "./create-update-handler";
import { currentTime } from "./global-store/current-time";
import { settings } from "./global-store/settings";
import {
  compareByTimestampInText,
  fromMarkdown,
  positionContainsPoint,
  sortListsRecursively,
  toEditorPos,
  toMarkdown,
  toMdastPoint,
} from "./mdast/mdast";
import { visibleDaysUpdated } from "./redux/global-slice";
import {
  initialIcalState,
  type IcalState,
  icalRefreshRequested,
} from "./redux/ical/ical-slice";
import { initListenerMiddleware } from "./redux/listener-middleware";
import { settingsUpdated } from "./redux/settings-slice";
import { type AppStore, makeStore } from "./redux/store";
import { createUseSelector } from "./redux/use-selector";
import { DataviewFacade } from "./service/dataview-facade";
import { TransactionWriter } from "./service/diff-writer";
import { STaskEditor } from "./service/stask-editor";
import { VaultFacade } from "./service/vault-facade";
import { WorkspaceFacade } from "./service/workspace-facade";
import {
  type DayPlannerSettings,
  defaultSettings,
  type PluginData,
} from "./settings";
import { createGetTasksApi } from "./tasks-plugin";
import type { ObsidianContext, OnUpdateFn } from "./types";
import { createEditorMenuCallback } from "./ui/editor-menu";
import { mountStatusBarWidget } from "./ui/hooks/use-status-bar-widget";
import MultiDayView from "./ui/multi-day-view";
import { DayPlannerReleaseNotesView } from "./ui/release-notes";
import { DayPlannerSettingsTab } from "./ui/settings-tab";
import TimelineView from "./ui/timeline-view";
import { createHooks } from "./util/create-hooks.svelte";
import { createRenderMarkdown } from "./util/create-render-markdown";
import { createShowPreview } from "./util/create-show-preview";
import { createDailyNoteIfNeeded } from "./util/daily-notes";
import { notifyAboutStartedTasks } from "./util/notify-about-started-tasks";
import { execOnTasks } from "./util/exec-on-tasks";

export default class DayPlanner extends Plugin {
  settings!: () => DayPlannerSettings;
  private settingsStore!: Writable<DayPlannerSettings>;
  private workspaceFacade!: WorkspaceFacade;
  private dataviewFacade!: DataviewFacade;
  private sTaskEditor!: STaskEditor;
  private vaultFacade!: VaultFacade;
  private transationWriter!: TransactionWriter;
  private syncDataview?: () => void;
  private currentUndoNotice?: Notice;
  private store!: AppStore;

  async onload() {
    this.dataviewFacade = new DataviewFacade(
      () => getAPI(this.app),
      this.app.vault,
    );
    const initialPluginData: PluginData = {
      ...defaultSettings,
      ...(await this.loadData()),
    };

    await this.setUpReduxStore(initialPluginData);
    await this.initSettingsStore(initialPluginData);

    const getTasksApi = createGetTasksApi(this.app);

    this.vaultFacade = new VaultFacade(this.app.vault, getTasksApi);
    this.transationWriter = new TransactionWriter(this.vaultFacade);
    this.workspaceFacade = new WorkspaceFacade(
      this.app.workspace,
      this.vaultFacade,
    );
    this.sTaskEditor = new STaskEditor(
      this.workspaceFacade,
      this.vaultFacade,
      this.dataviewFacade,
    );

    this.registerViews();
    this.registerCommands();
    this.addRibbonIcons();
    this.addSettingTab(new DayPlannerSettingsTab(this, this.settingsStore));

    await this.handleNewPluginVersion();
    await this.initTimelineLeafSilently();
  }

  async onunload() {
    return Promise.all([
      this.detachLeavesOfType(viewTypeTimeline),
      this.detachLeavesOfType(viewTypeMultiDay),
    ]);
  }

  addRibbonIcons() {
    this.addRibbonIcon(
      "calendar-range",
      "Open Timeline",
      this.initTimelineLeaf,
    );
    this.addRibbonIcon("table-2", "Open Multi-Day View", this.initWeeklyLeaf);
  }

  initWeeklyLeaf = async () => {
    await this.app.workspace.getLeaf("tab").setViewState({
      type: viewTypeMultiDay,
      active: true,
    });
  };

  initTimelineLeafSilently = async () => {
    this.app.workspace.onLayoutReady(async () => {
      const [firstExistingTimeline] =
        this.app.workspace.getLeavesOfType(viewTypeTimeline);
      if (firstExistingTimeline) {
        return;
      }

      await this.detachLeavesOfType(viewTypeTimeline);

      await this.app.workspace.getRightLeaf(false)?.setViewState({
        type: viewTypeTimeline,
      });
    });
  };

  initTimelineLeaf = async () => {
    const [firstExistingTimeline] =
      this.app.workspace.getLeavesOfType(viewTypeTimeline);

    if (firstExistingTimeline) {
      this.app.workspace.revealLeaf(firstExistingTimeline);
      return;
    }

    await this.detachLeavesOfType(viewTypeTimeline);
    await this.app.workspace.getRightLeaf(false)?.setViewState({
      type: viewTypeTimeline,
      active: true,
    });
    this.app.workspace.rightSplit.expand();
  };

  private async handleNewPluginVersion() {
    if (this.settings().pluginVersion === currentPluginVersion) {
      return;
    }

    this.settingsStore.update((previous) => ({
      ...previous,
      pluginVersion: currentPluginVersion,
    }));

    if (this.settings().releaseNotes) {
      this.app.workspace.onLayoutReady(async () => {
        await this.showReleaseNotes();
      });
    }
  }

  private registerCommands() {
    this.addCommand({
      id: "show-day-planner-timeline",
      name: "Show timeline",
      callback: async () => await this.initTimelineLeaf(),
    });

    this.addCommand({
      id: "show-weekly-view",
      name: "Show week planner",
      callback: this.initWeeklyLeaf,
    });

    this.addCommand({
      id: "show-multi-day-view",
      name: "Show multi-day planner",
      callback: this.initWeeklyLeaf,
    });

    this.addCommand({
      id: "show-day-planner-today-note",
      name: "Open today's Day Planner",
      callback: async () => {
        const dailyNote = await createDailyNoteIfNeeded(window.moment());

        await this.app.workspace.getLeaf(false).openFile(dailyNote);
      },
    });

    this.addCommand({
      id: "reorder-tasks-by-time",
      name: "Sort tasks under cursor by time",
      editorCallback: (editor) => {
        const mdastRoot = fromMarkdown(editor.getValue());
        const cursorPoint = toMdastPoint(editor.getCursor());

        // todo: move out
        const list = mdastRoot.children.find(
          (rootContent) =>
            rootContent.position &&
            positionContainsPoint(rootContent.position, cursorPoint),
        );

        if (!list) {
          new Notice("There is no list under cursor");

          return;
        }

        const sorted = sortListsRecursively(list, compareByTimestampInText);
        const updatedText = toMarkdown(sorted).trim();

        isNotVoid(sorted.position);

        editor.replaceRange(
          updatedText,
          toEditorPos(sorted.position.start),
          toEditorPos(sorted.position.end),
        );
      },
    });

    this.addCommand({
      id: "clock-in",
      icon: "play",
      name: "Clock in",
      // @ts-expect-error
      editorCallback: this.sTaskEditor.clockInUnderCursor,
    });

    this.addCommand({
      icon: "square",
      id: "clock-out",
      name: "Clock out",
      editorCallback: this.sTaskEditor.clockOutUnderCursor,
    });

    this.addCommand({
      icon: "trash-2",
      id: "cancel-clock",
      name: "Cancel clock",
      // @ts-expect-error
      editorCallback: this.sTaskEditor.cancelClockUnderCursor,
    });
  }

  private async initSettingsStore(initialSettings: DayPlannerSettings) {
    settings.set(initialSettings);

    this.register(
      settings.subscribe(async (newValue) => {
        this.store.dispatch(settingsUpdated(newValue));

        await this.saveData(newValue);
      }),
    );

    this.settingsStore = settings;
    this.settings = () => get(settings);
  }

  private async detachLeavesOfType(type: string) {
    // Although this is synchronous, without wrapping into a promise, weird things happen:
    // - when re-initializing the weekly view, it gets deleted every other time instead of getting re-created
    // - or the tabs get hidden
    await this.app.workspace.detachLeavesOfType(type);
  }

  private showReleaseNotes = async () => {
    await this.app.workspace.getLeaf("tab").setViewState({
      type: viewTypeReleaseNotes,
      active: true,
    });
  };

  getSTaskUnderCursor = (view: MarkdownFileInfo) => {
    isInstanceOf(
      view,
      MarkdownView,
      "You can only get tasks from markdown editor views",
    );

    const file = view.file;

    isNotVoid(file, "There is no file for view");

    const sTask = this.dataviewFacade.getTaskAtLine({
      path: file.path,
      line: view.editor.getCursor().line,
    });

    isNotVoid(sTask, "There is no task under cursor");

    return sTask;
  };

  private registerViews() {
    const onUpdate: OnUpdateFn = createUpdateHandler({
      app: this.app,
      settings: this.settings,
      transactionWriter: this.transationWriter,
      vaultFacade: this.vaultFacade,
      onEditCanceled: () => {
        new Notice("Edit canceled");

        // We need to manually reset tasks to the initial state
        // todo: use an optimistic update
        this.syncDataview?.();
      },
    });

    const onEditAborted = () => {
      new Notice("Tasks changed externally; edit canceled");
    };

    const useSelector = createUseSelector(this.store);
    const {
      editContext,
      tasksWithTimeForToday,
      dataviewLoaded,
      isModPressed,
      newlyStartedTasks,
      isOnline,
      isDarkMode,
      dateRanges,
      dataviewSyncTrigger,
      pointerDateTime,
      tasksWithActiveClockProps,
      getDisplayedTasksWithClocksForTimeline,
      visibleDays,
    } = createHooks({
      app: this.app,
      dataviewFacade: this.dataviewFacade,
      workspaceFacade: this.workspaceFacade,
      settingsStore: this.settingsStore,
      onUpdate,
      onEditAborted,
      currentTime,
      dispatch: this.store.dispatch,
      plugin: this,
      useSelector,
    });

    this.syncDataview = () => dataviewSyncTrigger.set({});

    this.registerDomEvent(window, "blur", editContext.cancelEdit);
    this.registerDomEvent(document, "pointerup", editContext.cancelEdit);

    const handleEditorMenu = createEditorMenuCallback({
      sTaskEditor: this.sTaskEditor,
      plugin: this,
    });

    this.registerEvent(
      // todo: move out
      this.app.workspace.on("editor-menu", handleEditorMenu),
    );

    this.register(
      editContext.cursor.subscribe(({ bodyCursor }) => {
        document.body.style.cursor = bodyCursor;
      }),
    );
    this.register(
      visibleDays.subscribe((days) => {
        this.store.dispatch(
          // without the offset, an event right of UTC is going to be displayed as the previous day
          // a visible day in my zone is 2025-04-15, but in UTC it's 2025-04-14T22:00:00, and getDayKey returns 2025-04-14
          visibleDaysUpdated(days.map((it) => it.toISOString(true))),
        );
      }),
    );

    const errorStore = writable<Error | undefined>();

    const destroyStatusBarWidget = mountStatusBarWidget({
      plugin: this,
      errorStore,
      dateRanges,
      tasksWithTimeForToday,
    });

    this.register(destroyStatusBarWidget);

    this.register(
      tasksWithTimeForToday.subscribe((value) =>
        execOnTasks(value, this.settings()),
      )
    )

    this.register(
      newlyStartedTasks.subscribe((value) =>
        notifyAboutStartedTasks(value, this.settings()),
      ),
    );
    this.addCommand({
      id: "re-sync",
      name: "Re-sync tasks",
      callback: async () => {
        this.store.dispatch(icalRefreshRequested());
      },
    });

    this.addCommand({
      id: "jump-to-active-clock",
      name: "Jump to active clock",
      callback: () => {
        const currentTasksWithActiveClockProps = get(tasksWithActiveClockProps);

        if (currentTasksWithActiveClockProps.length === 0) {
          new Notice("No active clocks found");

          return;
        }

        const firstTaskWithActiveClockProp =
          currentTasksWithActiveClockProps[0];

        const { location } = firstTaskWithActiveClockProp;

        isNotVoid(location);

        this.workspaceFacade.revealLineInFile(
          location.path,
          location.position?.start?.line,
        );
      },
    });

    //todo: show only in dev mode
    // this.addCommand({
    //   id: "dump-metadata",
    //   name: "Dump metadata to files",
    //   callback: createDumpMetadataCommand(this.app),
    // });

    const defaultObsidianContext: ObsidianContext = {
      sTaskEditor: this.sTaskEditor,
      workspaceFacade: this.workspaceFacade,
      initWeeklyView: this.initWeeklyLeaf,
      refreshDataviewFn: this.dataviewFacade.getAllTasksFrom,
      dataviewLoaded,
      renderMarkdown: createRenderMarkdown(this.app),
      toggleCheckboxInFile: this.vaultFacade.toggleCheckboxInFile,
      editContext,
      showPreview: createShowPreview(this.app),
      isModPressed,
      reSync: () => this.store.dispatch(icalRefreshRequested()),
      isOnline,
      isDarkMode,
      settings,
      settingsSignal: fromStore(settings),
      pointerDateTime,
      tasksWithActiveClockProps,
      getDisplayedTasksWithClocksForTimeline,
      dispatch: this.store.dispatch,
      store: this.store,
      useSelector,
    };

    const componentContext = new Map<
      string,
      ObsidianContext | typeof errorStore
    >([
      [obsidianContextKey, defaultObsidianContext],
      [errorContextKey, errorStore],
    ]);

    this.registerView(
      viewTypeTimeline,
      (leaf: WorkspaceLeaf) =>
        new TimelineView(leaf, this.settings, componentContext, dateRanges),
    );

    this.registerView(
      viewTypeMultiDay,
      (leaf: WorkspaceLeaf) =>
        new MultiDayView(
          leaf,
          this.settingsStore,
          componentContext,
          dateRanges,
        ),
    );

    this.registerView(
      viewTypeReleaseNotes,
      (leaf: WorkspaceLeaf) => new DayPlannerReleaseNotesView(leaf),
    );
  }

  private async setUpReduxStore(pluginData: PluginData) {
    const listenerMiddleware = initListenerMiddleware({
      extra: {
        dataviewFacade: this.dataviewFacade,
      },
      onIcalsFetched: async (rawIcals) => {
        await this.saveData({ ...this.settings(), rawIcals });
      },
    });

    const icalStateWithCachedRawIcals: IcalState = {
      ...initialIcalState,
      plainTextIcals: pluginData.rawIcals || [],
    };

    this.store = makeStore({
      preloadedState: {
        ical: icalStateWithCachedRawIcals,
      },
      middleware: (getDefaultMiddleware) => {
        return getDefaultMiddleware().concat(listenerMiddleware.middleware);
      },
    });

    this.register(() => {
      listenerMiddleware.clearListeners();
    });

    this.registerInterval(
      window.setInterval(() => {
        this.store.dispatch(icalRefreshRequested());
      }, icalRefreshIntervalMillis),
    );
  }
}
