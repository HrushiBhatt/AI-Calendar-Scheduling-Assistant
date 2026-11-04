//go:build js && wasm

package main

import (
	"syscall/js"
	_ "time/tzdata" // the browser has no zone files for Go to read
)

func main() {
	js.Global().Set("brewFocusPlan", js.FuncOf(func(_ js.Value, args []js.Value) any {
		return planJSON(args[0].String())
	}))
	js.Global().Set("brewFocusCheck", js.FuncOf(func(_ js.Value, args []js.Value) any {
		return checkJSON(args[0].String())
	}))
	select {} // the functions above must stay callable
}
