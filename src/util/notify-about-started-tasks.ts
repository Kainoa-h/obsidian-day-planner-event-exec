import type { DayPlannerSettings } from "../settings";
import type { Task, WithTime } from "../task-types";
// import { spawn } from "child_process";
const { spawn } = require("child_process");
import { getMinutesSinceMidnight } from "./moment";
import { createTimestamp, getOneLineSummary } from "./task-utils";

export function notifyAboutStartedTasks(
  tasks: WithTime<Task>[],
  settings: DayPlannerSettings,
) {
  if (tasks.length === 0) {
    return;
  }

  const firstTask = tasks[0];
  const summary = getOneLineSummary(firstTask);
  const timestamp = createTimestamp(
    getMinutesSinceMidnight(firstTask.startTime),
    firstTask.durationMinutes,
    settings.timestampFormat,
  );

  new Notification(`Task started: ${summary}
${timestamp}`);

  if (settings.execScriptPath) {
    const child = spawn("bash", [settings.execScriptPath], {
      env: {
        ...process.env,
        DAY_PLANNER_EVENT_TITLE: summary,
        DAY_PLANNER_EVENT_TIMESTAMP: timestamp,
      },
    });

    child.stdout.on("data", (data) => {
      console.log(`stdout: ${data}`);
    });

    child.stderr.on("data", (data) => {
      console.error(`stderr: ${data}`);
    });

    child.on("close", (code) => {
      console.log(`Script exited with code ${code}`);
      new Notification(`Script exited with code ${code}`);
    });
  }
  // if (settings.execScriptPath) {
  //   exec(`bash ${settings.execScriptPath}`, {
  //     env: {
  //       ...process.env,
  //       DAY_PLANNER_EVENT_TITLE: summary,
  //       DAY_PLANNER_EVENT_TIMESTAMP: timestamp,
  //     },
  //   }, (error, stdout, stderr) => {
  //     if (error) {
  //       new Notification(`Script ${settings.execScriptPath} failed`);
  //       console.log(stderr);
  //     }
  //     else {
  //       new Notification("Script successfully ran");
  //       console.log(stdout);
  //     }
  //   });
  // }
}
