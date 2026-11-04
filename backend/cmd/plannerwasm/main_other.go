//go:build !(js && wasm)

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "plannerwasm only runs in a browser: build it with GOOS=js GOARCH=wasm")
	os.Exit(2)
}
