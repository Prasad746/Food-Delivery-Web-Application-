import dns from "node:dns";

dns.setServers(["8.8.8.8", "8.8.4.4"]);

const { startServer } = await import("./index.js");

await startServer();