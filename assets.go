package main

import (
	"io/fs"
)

func mustAssets() fs.FS {
	files, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		panic(err)
	}
	return files
}
