import { Notice } from "obsidian";
import type { DayPlannerSettings } from "../settings";
import type { Task, WithTime } from "../task-types";
const { exec } = require("child_process");
import { getMinutesSinceMidnight } from "./moment";
import { createTimestamp, getOneLineSummary } from "./task-utils";
import { getEndTime } from "./task-utils";

let prevTask: Task | undefined;
enum taskState {
  done = "0",
  active = "1",
  upcoming = "2",
}
let prevTaskState: string = taskState.done;

export function execOnTasks(
  tasks: WithTime<Task>[],
  settings: DayPlannerSettings,
) {
  if (tasks.length === 0) {
    if (prevTask)
      runScript("", "done", taskState.done, settings);
    prevTask = undefined;
    prevTaskState = taskState.done;
    return;
  }

  const currentTime = window.moment();
  const sortedTasks = tasks.slice().sort((a, b) => a.startTime.diff(b.startTime));
  const currentTask = sortedTasks.find(
    (task) =>
      task.startTime.isBefore(currentTime) &&
      getEndTime(task).isAfter(currentTime),
  );

  if (currentTask) {
    if (currentTask == prevTask && prevTaskState == taskState.active) return;
    const title = getOneLineSummary(currentTask);
    const timestamp = createTimestamp(
      getMinutesSinceMidnight(currentTask.startTime),
      currentTask.durationMinutes,
      settings.timestampFormat,
    );
    runScript(timestamp, title, taskState.active, settings);
    prevTask = currentTask;
    prevTaskState = taskState.active;
    return;
  }

  const nextTask = sortedTasks.find((task) => task.startTime.isAfter(currentTime));
  if (nextTask) {
    if (nextTask == prevTask && prevTaskState == taskState.upcoming) return;
    const title = getOneLineSummary(nextTask);
    const timestamp = createTimestamp(
      getMinutesSinceMidnight(nextTask.startTime),
      nextTask.durationMinutes,
      settings.timestampFormat,
    );
    runScript(timestamp, title, taskState.upcoming, settings);
    prevTask = nextTask;
    prevTaskState = taskState.upcoming;
    return;
  }

  if (prevTask)
    runScript("", "done", taskState.done, settings);
  prevTask = undefined;
  prevTaskState = taskState.done;
  return;
}

function runScript(timestamp: string, title: string, status: string, settings: DayPlannerSettings) {
  if (settings.execScriptPath) {
    exec(`bash ${settings.execScriptPath}`, {
      env: {
        ...process.env,
        DAY_PLANNER_TASK_TITLE: title.trim(),
        DAY_PLANNER_TASK_TIMESTAMP: timestamp,
        DAY_PLANNER_TASK_STATUS: status,
      },
    }, (error, stdout, stderr) => {
      if (error) {
        new Notice("Day Planner: script failed", 3000);
        console.log(stderr);
      }
    });
  }
}
