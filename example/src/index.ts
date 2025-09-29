import * as wasm from "../rust-lib/src/lib.rs";

// Type definitions for better TypeScript support
type StatusType = "loading" | "success" | "error";

function updateStatus(message: string, type: StatusType = "success"): void {
  const statusElement: HTMLElement | null = document.getElementById("status");
  if (statusElement) {
    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
  }
}

function updateResult(id: string, value: string | number): void {
  const element: HTMLElement | null = document.getElementById(id);
  if (element) {
    element.textContent = String(value);
  }
}

async function main(): Promise<void> {
  try {
    updateStatus("🔄 Loading WebAssembly module...", "loading");

    // Test addition with explicit types
    const addResult: number = wasm.add(5, 3);
    updateResult("add-result", addResult);

    // Test fibonacci with explicit types
    const fibResult: number = wasm.fibonacci(10);
    updateResult("fibonacci-result", fibResult);

    // Test greet (this will log to browser console)
    wasm.greet("WebAssembly");

    updateStatus("✅ WebAssembly module loaded successfully!", "success");
  } catch (error: unknown) {
    console.error("Error loading WebAssembly module:", error);
    updateStatus("❌ Error loading WebAssembly module", "error");
  }
}

// Wait for DOM to be ready before running
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
