import os from "node:os"
import path from "node:path"

// Each test file runs in its own process. Give every process a private upload
// directory so multipart suites running in parallel cannot observe or delete
// each other's temporary files.
process.env.VINGO_TEST_UPLOAD_DIR = path.join(os.tmpdir(), `vingo-test-uploads-${process.pid}`)
