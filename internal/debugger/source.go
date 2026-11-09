package debugger

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

type FileList struct {
	Root      string   `json:"root"`
	Paths     []string `json:"paths"`
	Truncated bool     `json:"truncated"`
}

func (s *Session) root() string {
	if s.config.Cwd != "" {
		return s.config.Cwd
	}
	return ""
}

func within(root, path string) bool {
	if root == "" {
		return false
	}
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (s *Session) ReadSource(path string) (SourceFile, error) {
	if !filepath.IsAbs(path) {
		return SourceFile{}, errors.New("source path must be absolute")
	}
	path = filepath.Clean(path)
	s.mu.Lock()
	known := s.knownSources[path]
	s.mu.Unlock()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return SourceFile{}, err
	}
	root, _ := filepath.EvalSymlinks(s.root())
	if !known && !within(root, resolved) {
		return SourceFile{}, errors.New("source is outside the project and has not been reported by the adapter")
	}
	f, err := os.Open(resolved)
	if err != nil {
		return SourceFile{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return SourceFile{}, err
	}
	if !info.Mode().IsRegular() {
		return SourceFile{}, errors.New("source is not a regular file")
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxSourceBytes+1))
	if err != nil {
		return SourceFile{}, err
	}
	if len(b) > MaxSourceBytes {
		return SourceFile{}, errors.New("source exceeds the 1 MiB viewer limit; open it in your editor")
	}
	if !utf8.Valid(b) {
		return SourceFile{}, errors.New("source is not UTF-8 text")
	}
	hash := sha256.Sum256(b)
	return SourceFile{Path: path, Content: string(b), Hash: hex.EncodeToString(hash[:])}, nil
}

func (s *Session) Files() (FileList, error) {
	root := s.root()
	result := FileList{Root: root, Paths: []string{}}
	if root == "" {
		return result, nil
	}
	visited := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		visited++
		if visited > 20000 || len(result.Paths) >= 2000 {
			result.Truncated = true
			return fs.SkipAll
		}
		if entry.IsDir() && path != root {
			name := entry.Name()
			if strings.HasPrefix(name, ".") || name == "node_modules" || name == "vendor" || name == "dist" || name == "bin" {
				return fs.SkipDir
			}
		}
		if !entry.IsDir() && entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".go") {
			result.Paths = append(result.Paths, path)
		}
		return nil
	})
	sort.Strings(result.Paths)
	return result, err
}
