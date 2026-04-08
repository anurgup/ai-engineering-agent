import { StateGraph, END, START } from "@langchain/langgraph";
import { AgentStateAnnotation } from "./state.js";
import { readProjectConfig } from "./nodes/readProjectConfig.js";
import { inferProjectConfig } from "./nodes/inferProjectConfig.js";
import { readTicket } from "./nodes/readTicket.js";
import { readNotion } from "./nodes/readNotion.js";
import { readMemory } from "./nodes/readMemory.js";
import { classifyIssue } from "./nodes/classifyIssue.js";
import { readRepoContext } from "./nodes/readRepoContext.js";
import { generateCode } from "./nodes/generateCode.js";
import { humanReview } from "./nodes/humanReview.js";
import { pushToGitHub } from "./nodes/pushToGitHub.js";
import { updateNotion } from "./nodes/updateNotion.js";
import { markDone } from "./nodes/markDone.js";
import { handleRejection } from "./nodes/handleRejection.js";

function routeAfterReview(state: typeof AgentStateAnnotation.State): string {
  return state.humanApproved ? "pushToGitHub" : "handleRejection";
}

export function buildGraph() {
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode("readProjectConfig", readProjectConfig)
    .addNode("readTicket", readTicket)
    .addNode("readNotion", readNotion)
    .addNode("readMemory", readMemory)
    .addNode("inferProjectConfig", inferProjectConfig)
    .addNode("classifyIssue", classifyIssue)
    .addNode("readRepoContext", readRepoContext)
    .addNode("generateCode", generateCode)
    .addNode("humanReview", humanReview)
    .addNode("pushToGitHub", pushToGitHub)
    .addNode("updateNotion", updateNotion)
    .addNode("markDone", markDone)
    .addNode("handleRejection", handleRejection)

    // Context gathering pipeline
    .addEdge(START, "readProjectConfig")        // ← read project.yml / auto-clone first
    .addEdge("readProjectConfig", "readTicket")
    .addEdge("readTicket", "readNotion")
    .addEdge("readNotion", "readMemory")             // ← search past PRs + issues
    .addEdge("readMemory", "inferProjectConfig")    // ← auto-infer stack if no project.yml
    .addEdge("inferProjectConfig", "classifyIssue") // ← classify fresh vs modification
    .addEdge("classifyIssue", "readRepoContext")  // ← read relevant existing files
    .addEdge("readRepoContext", "generateCode")   // ← generate with full context

    // Conditional branch on approval
    .addEdge("generateCode", "humanReview")
    .addConditionalEdges("humanReview", routeAfterReview, {
      pushToGitHub: "pushToGitHub",
      handleRejection: "handleRejection",
    })

    // Post-approval flow
    .addEdge("pushToGitHub", "updateNotion")
    .addEdge("updateNotion", "markDone")
    .addEdge("markDone", END)
    .addEdge("handleRejection", END);

  return graph.compile();
}
