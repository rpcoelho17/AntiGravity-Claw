# 🦀 AntiGravityClaw — User Manual

AntiGravityClaw is a personal AI agent that lives on your computer but communicates through Telegram. It combines persistent memory, hybrid search, and project sandboxing to help you code and organize ideas from anywhere.

---

## 📋 Channel & Project Commands

The bot uses "Channels" to keep your conversations organized. A channel can either be a simple **Chat-Only** space for brainstorming or a **Linked Project** for coding.

| Action | Example Commands |
| :--- | :--- |
| **Create New Channel** | `create a new channel called blog_project` <br> `start a new project named research` |
| **Switch Channel** | `switch to blog_project` <br> `go to my research channel` |
| **List Channels** | `list my channels` <br> `what are my projects?` |
| **Check Current Channel** | `what channel am I on?` <br> `which project am I using?` |
| **Rename Channel** | `rename this channel to personal_notes` |
| **Switch to Default** | `switch to default` <br> `go to the default channel` |

---

## 📂 Project Sandboxing & File Tools

AntiGravityClaw is geographically restricted to a secure workspace for safety. By default, all new channels are **Chat-Only** and cannot see or touch your files.

### The Secure Workspace
All projects are stored in:  
`D:\FILES\Code\BotProjects`

### Linking a Channel
To allow the bot to read/write/list files in a channel, you must "link" it to a folder:
*   **Command**: `link this channel to folder [folder_name]`
*   **Effect**: The bot will create (or use) a folder named `[folder_name]` inside the Secure Workspace.

### File Capabilities (Linked Channels only)
Once linked, the bot can:
*   **List Files**: View the contents of the project directory.
*   **Read Files**: Examine source code or documents.
*   **Write Files**: Create new files or modify existing ones.

---

## 🧠 Memory & Intelligence

The bot learns about you automatically as you chat.

*   **Semantic Search**: When you ask a question, the bot automatically searches your history across both Vector (meaning) and BM25 (exact words) indexes to provide relevant context.
*   **Rolling Summaries**: Every 20 messages, the bot automatically summarizes the conversation to keep its context high-quality and concise.
*   **Sanitization**: All search queries are automatically cleaned to ensure special characters (like `?`) don't break the database engine.

---

## 🔧 Maintenance & Setup

*   **ALLOWED_USER_IDS**: Only the user IDs listed in the `.env` file can talk to the bot.
*   **BASE_PROJECT_PATH**: This secure path can only be changed by editing the `.env` file via the AntiGravity IDE.
