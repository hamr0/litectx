Here is the full transcript of Marina Wyss's complete course video, *Context Engineering in 29 Minutes*, formatted directly into a clean Markdown format for you to save or use.

https://www.youtube.com/watch?v=-h9VVJIqtvA&t=28s

---

# Context Engineering in 29 Minutes: Complete Course

**Channel:** Marina Wyss - AI & Machine Learning

If you've been building AI agents, you've probably noticed something. Your agent works fine for the first few steps—it picks the right tools, reasons clearly, and stays on track. But somewhere around step 15 or 20, it starts getting a little sloppy. It forgets what you asked for, calls tools that don't make sense, or starts producing low-quality outputs. Most people's first assumption is that the model is the problem, but it's usually not. It's more often what the model is *seeing*.

Organizing what the model sees is called **context engineering**, and it's quickly becoming one of the most important skills for anyone working in this space. I'm Marina, a senior applied scientist at Twitch working on Gen AI. I went through dozens of sources for this video—engineering blogs, talks from conferences, academic papers, and practitioner reports—and distilled all of the best practices I could find into this one video.

Here's what we'll cover:

* First, what context engineering is and why agents specifically need it.
* Then, the four core strategies that you need to know.
* After that, the ways agents fail when context goes wrong and how to prevent it.
* Finally, we'll compare how platforms like Claude Code, ChatGPT, and Manus each approach this differently.

## Defining Context Engineering

Let's start by actually defining what we're talking about. You've definitely heard of prompt engineering—that's the skill of writing good instructions for an LLM, like phrasing things clearly, giving good examples, and telling the model what role to play. That works great when you're having a conversation with ChatGPT. But when you move from chatbots to agents, prompt engineering stops being enough.

The reason is pretty simple: an agent doesn't just answer one question. It takes actions like browsing the web, calling APIs, writing code, and running commands. It does all of this autonomously, step after step, sometimes for dozens of steps. Every single one of those steps produces output that gets added to the model's context, and that context is finite.

Context engineering is the discipline of designing the entire information system around the model—not just that initial instruction, but everything the model sees at every step: the system prompt, tool definitions, the results from previous calls, conversation history, and more.

Anthropic's engineering team defines it like this:

> "Context is the set of tokens included when you sample from an LLM, and context engineering is optimizing the utility of those tokens to consistently achieve a desired outcome."

So basically, it's making sure your agent sees the right information in the right format at the right time. Anthropic actually describes context engineering as the natural progression of prompt engineering. It includes everything prompt engineering does (like clear instructions, good examples, and structured formatting) but adds a whole layer on top: managing tools, external data, message history, memory systems, and dynamic state. You can think of prompt engineering as a subset of context engineering.

Getting good at context engineering matters right now because agent adoption is accelerating incredibly fast. Gartner projects that 40% of enterprise applications will integrate task-specific AI agents by the end of 2026, up from less than 5% in 2025. Teams that figure out context engineering are the ones whose agents will actually work reliably. This is because agents move us from static prompts and RAG (Retrieval-Augmented Generation) pipelines to a dynamic system. Now, every tool call, retrieved document, and decision the agent makes gets packed into a context window that's filling up with operations the user never explicitly asked for.

## The Context Problem: Degradation and "Lost in the Middle"

Context has a fixed size, which is a problem if it's filling up with a bunch of random stuff. LangChain has a nice analogy for this: think of an LLM as a new kind of operating system. The model itself is the CPU—it does the thinking—and the context window is RAM, the working memory where everything the model can currently see and reason about lives. Just like your computer slows down when RAM fills up, your agent's reasoning degrades when your context window gets crowded. This is called **context rot** or context degradation.

Chroma published a really important study where they evaluated 18 Frontier models (GPT-4.1, Claude 4, Gemini 2.5, Qwen 3, and others). What they found is that every single model's performance degrades as input length increases, even well below the stated context window limit. A model with a 200k token window might start showing significant degradation at 50k tokens. The decline is continuous, not like a sudden cliff. Anthropic also talks about this in their engineering blog, confirming that context degradation is a gradient.

The technical reason has to do with how transformers work. Every token attends to every other token, creating $n^2$ pairwise relationships. As the context grows, the model's ability to capture all those relationships gets stretched thinner and thinner. It's like asking a person to keep track of an increasingly large number of things simultaneously; at some point, stuff gets dropped.

There's also a well-studied phenomenon called **"lost in the middle."** A research team found that LLMs exhibit a U-shaped attention curve. They remember information at the beginning of the context well and at the end well, but information in the middle gets missed. The team measured a 30+ percentage point drop in accuracy when relevant information moved from the beginning of the context to the middle. You can think about what that means for an agent whose original instructions are buried under 50,000 tokens of tool outputs—those instructions effectively disappear.

## The 7 Categories Competing for Context

So we know the context window is finite and degrades as it fills, but what's actually competing for that space? There are basically seven categories of information in an agent's context window:

1. **The System Prompt:** This is the agent's identity, its behavioral rules, control flow logic, and instructions for how it should approach different types of tasks. In an agent, this isn't just like "you are a helpful assistant"—it can define the entire architecture of how the agent operates.
2. **Tool Definitions:** Every tool the agent could potentially call needs a schema in the context describing what it does, what parameters it takes, and when to use it.
3. **Results of Tool Calls:** Every time the agent calls a tool, the result gets added to the context. A webpage retrieval might be 5,000 to 10,000 tokens; a file read could be similar.
4. **Retrieved Knowledge from RAG:** These are documents pulled from vector databases, search results, or API responses—anything the agent or the system retrieves to inform the agent's decisions.
5. **Conversation History:** The full transcript of everything that's happened in the session, including the user's messages, the agent's responses, its reasoning, and its prior decisions. This grows linearly with every turn.
6. **Memory:** Both short-term memory from the current session and long-term memory from previous sessions. That would be things like user preferences, prior task outcomes, and learned patterns.
7. **Agent State:** This is the agent's current plan, its to-do list, progress markers, and scratchpad notes—all of that meta-information that helps the agent track where it is in a multi-step task.

Now we know what the problem is. The rest of this course is all about how to effectively make that context work well together. But even with perfect context engineering, we're still going to benefit from a model that's built for this kind of work.

*Sponsor Segment:* Kimmy just released K2.6, an open-source LLM that hit state-of-the-art on SWE-bench Pro. Their team demonstrated it on a task where an agent ran autonomously for 13 hours, made over a 1,000 tool calls, modified 4,000 lines of code, and nearly tripled throughput on an already optimized codebase—all while being significantly more cost-effective. K2.6 reaches the same outcomes in about 35% fewer steps than the previous version. Fewer unnecessary tool calls means less junk in the context window. They also have an agent swarm where you can spin up 300 sub-agents in parallel, each with its own clean context window. Kimmy Code is a full-stack CLI agent like Claude Code, featuring a website builder, slide generation, and local open-source support.

---

## The Four Core Strategies: Write, Select, Compress, Isolate

How do you decide what goes in, what stays out, and what gets compressed? LangChain published a widely cited framework that organizes every context engineering technique into four categories: **Write, Select, Compress, and Isolate**. Once you're familiar with these four buckets, every technique you encounter will fit into one of them.

### 1. Write

The problem this solves is simple: agents forget things. When an agent's context fills up and gets compacted, it loses information. If the agent didn't write anything down before that happened, that information is just gone. "Write" means giving the agent ways to persist information *outside* the context window. This takes a few forms:

* **Scratchpads:** Giving the agent a tool that lets it take notes during a task to jot down intermediate findings, track decisions, or save information it will need later. Anthropic built something called the "think tool," which gives Claude a dedicated workspace for working through these kinds of problems, improving performance by 54% on certain tasks.
* **Rules Files:** A kind of persistent procedural memory. If you've used Claude Code, you've probably seen `claude.md`. These are instructions loaded at the start of every agent session—basically the agent's standing orders detailing project structure, conventions, how to run tests, and what to be careful about. The agent reads them every time it starts up so it never forgets the fundamentals.
* **Memory Extraction:** The agent saving facts, user preferences, or learned patterns so it can retrieve them across sessions. It's a file-based system that lets the agent store and consult information living outside the context window entirely.

### 2. Select

The core idea here is: don't give the agent everything; give it what it needs for the current step. An agent with access to dozens of tools, a large knowledge base, and several sessions of conversation history can't load all of that into the context at once. Something has to decide what's relevant right now.

In traditional RAG, the system makes that decision—the user asks a question, you retrieve documents, stuff them into the prompt, and you're done. It's a static pipeline where the model has no say. **Agentic RAG** flips this around: the agent itself decides what to search for, what tools to use, how to refine its queries, and when it has enough information. It treats retrieval as an iterative process instead of a one-shot pipeline. This matters because what's relevant changes at every step of a multi-step task, and the agent is the only one who knows what it needs next.

What does the agent actually select from? LangChain and Pinecone both distinguish three types of memory it can draw on:

* **Episodic memory:** Few-shot examples of how it handled something similar before.
* **Semantic memory:** A repository of facts the agent has learned or been told.
* **Procedural memory:** Standing behavioral instructions like the rules files we talked about.

One major selection problem that trips people up is **tools**. If your agent has access to 40+ tools, that's potentially 10,000 tokens of tool definitions sitting in the context before any work has even started. Too many tools doesn't just waste space; it actively confuses the model. The fix is to use RAG over the tool definitions themselves. Instead of dumping every tool schema into the context, you use semantic search to surface just the relevant tools for the current step. A paper called *RAG-MCP* tested this and found tool selection accuracy jumped from 14% to 43% while cutting prompt tokens roughly in half.

Anthropic's general advice is a hybrid strategy: load some essential information up front for speed (like the `claude.md` file) but let the agent do just-in-time retrieval for everything else. Frontload the basics, retrieve the rest on demand.

### 3. Compress

This strategy directly addresses the context rot problem. Imagine your agent has made 20 tool calls; its context now contains 80,000 tokens of accumulated tool outputs, conversation history, and reasoning traces. Most of those tool outputs are no longer relevant since the agent already acted on them, but they're still sitting there taking up space, degrading attention, and driving up cost and latency. Compression is about reducing token count while preserving the information that actually matters. You can compress at three different points in the pipeline:

* **Before entering the context:** This is where chunking comes in (breaking large documents into smaller, coherent pieces before retrieval) and reranking them so only the most useful chunks make it into the window. You can also summarize tool outputs on the fly before they enter the main context.
* **While the agent is working:** The most common technique here is summarization of conversation history. A running summary gets continuously updated after each exchange so you always have a compact version of everything that's happened. A popular pattern is a hybrid approach: keep the last 10 messages verbatim (since the agent might still need the exact details) but summarize everything older than that. Beyond summarization, there's plain trimming using hard-coded heuristics that remove older messages once the context hits a certain size. Claude Code has auto-compaction built in; when the context hits 95% capacity, it automatically summarizes the full trajectory.
* **After the agent has acted:** An easy win here is tool result clearing. Once a tool was called 15 steps ago and the agent already used the result, you can just drop the raw output. The agent doesn't need the full text of a web page it fetched ages ago; you can replace it with a one-line summary or remove it entirely.

### 4. Isolate

Isolation is arguably the most powerful strategy and is what makes multi-agent systems possible. If a single agent tries to do everything—like research, plan, code, test, and debug all in one long conversation—it will inevitably fill up its context. But the deeper issue isn't just space; it's **contamination**. The detailed file searches from the research phase are still sitting in the context when the agent moves to implementation. That old research context is now just noise, distracting the model during a phase where it needs to be focused on writing clean code.

The solution is context isolation, which means giving different parts of the work their own separate context windows. The most obvious form of this is using **sub-agents**. A parent agent delegates a focused subtask—like "search the codebase for all files related to authentication"—to a sub-agent. That sub-agent works in its own clean context window. When it reports back to the parent, it returns only a condensed summary, and all the messy search operations stay isolated in the sub-agent's context, never polluting the parent.

---

## Four Core Failure Modes (and How to Fix Them)

Drew Breunig published an influential two-part series in mid-2025 identifying four distinct ways agents fail as their context grows. Once you can name the failure, the solution maps directly back to our core strategies.

| Failure Mode | Description | Strategy Fix |
| --- | --- | --- |
| **Context Poisoning** | A hallucination or error enters the agent's context and gets referenced over and over in subsequent steps. Because agents iterate on their own output, each bad step compounds into the next. | **Compress & Select:** Actively prune or remove outdated/conflicting information. Validate tool outputs before injection. Compress failed attempt histories so only the final resolution remains visible. |
| **Context Distraction** | The context gets so long that the model starts over-relying on recent history and under-relying on what it learned during training. The agent stops thinking for itself and just repeats patterns from recent actions instead of synthesizing a novel plan. | **Compress:** Aggressively summarize and prune past conversation states, even when large context windows are technically available. |
| **Context Confusion** | Superfluous content gets into the context and leads to low-quality responses. The classic example is **tool confusion**—giving a model too many tools to reason about clearly, causing it to call irrelevant ones. | **Select:** Implement dynamic tool management. Use approaches like *RAG-MCP* to semantically retrieve and surface only the tools needed for the current phase. |
| **Context Clash** | New information the agent gathers during its run directly contradicts something already in the context (e.g., the system prompt says one thing, but a retrieved document says another), leading to inconsistent behavior. | **Write & Select:** Establish a clear authority ordering in your context (e.g., System Prompt > Retrieved Facts > Conversation History). Use structured sections with XML tags or clear markdown headers so the model knows which source to trust. |

---

## Engineering System Prompts and Tool Definitions

When building an agent, the system prompt and tool definitions look completely different than they do for a standard chatbot.

### Writing Prompts at the Right Altitude

A chatbot system prompt basically sets a tone ("be concise and friendly"). An agent system prompt defines its architecture, specifying control flow, how to approach tasks, what tools to use in what situations, error handling, and safety guardrails. It's closer to writing a job description for an autonomous employee.

Anthropic uses a concept called **"writing at the right altitude."** There is a Goldilocks zone for agent system prompts:

* **Too prescriptive is bad:** If you write rigid rules like *"If the user mentions billing and a refund and the amount is over $100, call tool X,"* it is too fragile and will break on every edge case you didn't anticipate.
* **Too vague is also bad:** Instructions like *"Be helpful and use the appropriate tools"* give the agent nothing to work with. It can't make good autonomous decisions without concrete signals.
* **The sweet spot:** Provide specific heuristics to guide autonomous behavior, but keep it flexible enough to let the model apply its own judgment in novel situations.

**Practical Tips:**

1. **Organize with structure:** Use XML tags or markdown headers to break the prompt into distinct sections like background information, instructions, and tool guidance.
2. **Start minimal and iterate on failures:** Don't try to anticipate every edge case up front. Run the agent against real tasks, observe where it breaks, and add instructions to address those specific failure modes. Minimal doesn't mean short—an agent prompt for a complex workflow can easily be thousands of tokens, as long as every token is necessary.
3. **Use few-shot examples:** Instead of trying to articulate every rule in words, show the agent what good behavior looks like. Give it diverse, canonical examples of correct tool selection, good reasoning, and proper multi-step execution.

### Tool Scaling: Masking vs. RAG Selection

Every tool needs a schema describing its purpose, parameters, and usage instructions, meaning tool definitions consume a massive amount of context. In production, this is increasingly handled through MCP (Model Context Protocol)—a standard way for agents to connect to external tool servers (GitHub, databases, file systems). Because MCP makes it incredibly easy to plug in tools, it introduces a dangerous trap: connecting four or five MCP servers can eat thousands of tokens before any work begins.

If your agent legitimately needs a lot of tools, there are two primary approaches to scaling them:

1. **Tool Masking (The Manus Approach):** Manus explicitly warns against dynamically adding and removing tool definitions mid-conversation because doing so invalidates the **KV (Key-Value) Cache**. When you send tokens to an LLM, the model computes expensive key-value representations for each token. If the early part of your context (the prefix) stays identical between API calls, providers can cache this computation, making subsequent turns up to 10x cheaper and significantly faster. Rearranging or removing tool definitions mid-run invalidates this cache, forcing a full re-computation. Tool masking solves this by keeping all tool definitions completely stable at the top of the context (maximizing cache reuse) but using a parameter or system instruction to mark certain tools as "unavailable" for the current phase.
2. **RAG-Based Tool Selection:** For systems with massive toolsets where loading them all is impossible, semantic retrieval is used to pre-select and inject only the tools relevant to the current step.

> **The Broader Architecture Principle:** Stable content goes at the top of your context window (system prompts, tool definitions, rules files) to maximize KV cache reuse. Dynamic content (conversation history, the current step, agent state) gets appended at the bottom.

---

## The Methodology: Frequent Intentional Compaction

DeXy, the CEO of Human Layer, presented a practical methodology at the AI Engineer Code Summit called **frequent intentional compaction**. His team reportedly used it to ship around 35,000 lines of code to a large Rust codebase in a single 7-hour session.

The core idea is to proactively structure your agent's work into discrete phases. Each phase produces a compacted, structured markdown artifact. When a new phase starts, the system wipes the messy operational history and opens a fresh context window containing *only* that compacted artifact. This deliberately keeps the agent running in the optimal 40% to 60% zone of its context window.

```
[Phase 1: Research] ──> Generates Research Artifact (Markdown) ──> Context Reset
                                                                          │
[Phase 2: Planning] ──> Generates Implementation Plan (Human Review) ◄────┘
                                                                          │
[Phase 3: Execution] ─> Tracks progress via progress.md ◄────────────────┘

```

* **Phase 1: Research:** Before any code is written, the agent explores the codebase, reads files, and traces data flows. Sub-agents handle the raw file searches and code analysis (**Isolate strategy**). All the messy grep results and raw file contents stay in the sub-agents' context windows. The output of this phase is a single, compact `research.md` file containing file paths, function signatures, and architecture gotchas (**Write strategy**).
* **The Context Reset:** The raw research might have consumed 80% of the context window, but the research artifact compresses all of that down to 15% (**Compress strategy**). The entire operational history is cleared.
* **Phase 2: Planning:** A brand-new context window opens containing only the compact research document and the problem definition. The agent uses this clean space to produce a detailed implementation plan. This is the ultimate checkpoint for a **Human-in-the-Loop** review to catch logical errors early.
* **Phase 3: Implementation:** Another fresh context window opens containing only the approved plan. The agent follows it step-by-step. For highly complex tasks requiring multiple cycles, a persistent `progress.md` file tracks what has been completed and what remains (**Write strategy**).

---

## Architectural Comparison of Major Platforms

Different platforms approach context engineering with unique design philosophies based on their primary use cases:

### Claude Code (Anthropic)

* **Philosophy:** Code-centric, text-driven, "do the simplest thing that works."
* **Implementation:** Employs a hybrid retrieval model where foundational rules (`claude.md`) are frontloaded for cache stability. It uses tools like Glob and Grep for just-in-time codebase navigation rather than pre-indexing everything. Features built-in auto-compaction at 95% utilization, falling back to preserving architectural choices and the 5 most recently accessed files. Spawns clean sub-agents for heavy tasks.

### Manus

* **Philosophy:** Infrastructure-heavy, highly focused on scale, cost, and latency optimization.
* **Implementation:** Heavily relies on KV cache-aware context ordering. It enforces strict tool masking instead of dynamic tool removal to keep the context prefix perfectly stable. Processes every tool output through an aggressive observation compression pipeline before it ever enters the main agent context, using the local file system as overflow storage for evicted context.

### ChatGPT Agent / Operator (OpenAI)

* **Philosophy:** GUI-first, visual, general-purpose automation.
* **Implementation:** Instead of text-based tool calls, the agent interacts with a visual browser environment. Screenshots are added to the context as visual snapshots, and the model reasons over visual tokens and a history of past screen states. Because visual tokens are incredibly expensive, OpenAI uses reinforcement learning to discover optimal tool-use and screenshot-retention strategies across thousands of virtual machines, rather than explicitly programming the context pipeline.

### ADK (Google)

* **Philosophy:** Highly disciplined, principled software architecture.
* **Implementation:** Codifies context management into three strict architectural principles:
1. *Separate storage from presentation:* The agent's internal, durable state tracking is completely decoupled from what is sent in individual API calls.
2. *Explicit transformations:* Uses named, ordered processors to transform and filter context into testable, composable steps rather than using ad-hoc string concatenation.
3. *Scope context by default:* Every single model call is treated as isolated; it sees only the absolute bare minimum required information, and nothing lands in the context window unless it is explicitly whitelisted.



---

## The Standard Agent Turn Pipeline

When you look across all these cutting-edge platforms, a common engineering pipeline emerges on every single agent turn:

```
1. COLLECT   ──> Gather user input, conversation history, tool results, RAG data, and state.
2. SELECT    ──> Score and filter what is relevant for the current step and token budget.
3. COMPRESS  ──> Summarize, truncate, or restructure the selected content to minimize tokens.
4. ORDER     ──> Arrange for KV Cache reuse: Stable content (system prompts, tools) FIRST.
5. ASSEMBLE  ──> Construct the final, structured payload and fire the LLM API call.

```

The space is moving incredibly fast, but the absolute best way to master this discipline is to start building, experiment with these boundaries, and see firsthand how your agent's behavior changes when you control exactly what it sees. All source papers and technical blogs are linked below in the video description if you want to dive deeper into the raw research.

Sources!
https://www.anthropic.com/engineering...
https://manus.im/blog/Context-Enginee...
https://blog.langchain.com/context-en...
https://www.anthropic.com/news/contex...
https://www.anthropic.com/engineering...
https://openai.com/index/introducing-...
https://openai.com/index/computer-usi...
https://research.trychroma.com/contex...
https://slack.engineering/managing-co...
https://developers.googleblog.com/arc...
https://www.pinecone.io/learn/context... 
https://github.com/humanlayer/advance...
https://www.humanlayer.dev/blog/advan...
https://www.dbreunig.com/2025/06/22/h...
https://www.dbreunig.com/2025/06/26/h...
   • Context Engineering Is the New Backend for...  
   • Advanced Context Engineering for Agents  
https://arxiv.org/abs/2307.03172
https://arxiv.org/abs/2505.03275
https://arxiv.org/abs/2510.04618
https://arxiv.org/pdf/2603.09619 
https://arxiv.org/abs/2510.21413
https://arxiv.org/abs/2501.09136
