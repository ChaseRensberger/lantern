package debugger

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sort"
	"sync"
	"time"
)

type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	order    []string
}

func NewManager() *Manager {
	return &Manager{sessions: make(map[string]*Session)}
}

func (m *Manager) Start(config LaunchConfig) (Snapshot, error) {
	if err := config.Validate(); err != nil {
		return Snapshot{}, err
	}
	idBytes := make([]byte, 12)
	if _, err := rand.Read(idBytes); err != nil {
		return Snapshot{}, err
	}
	id := hex.EncodeToString(idBytes)
	s := newSession(id, config)
	m.mu.Lock()
	if len(m.sessions) >= 32 {
		m.mu.Unlock()
		return Snapshot{}, errors.New("close an existing session before starting another; the limit is 32")
	}
	m.sessions[id] = s
	m.order = append(m.order, id)
	m.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(s.ctx, 2*time.Minute)
		defer cancel()
		if err := s.start(ctx); err != nil {
			s.fail(err)
			s.cleanup()
		}
	}()
	return s.Snapshot(), nil
}

func (m *Manager) Session(id string) (*Session, error) {
	m.mu.RLock()
	s := m.sessions[id]
	m.mu.RUnlock()
	if s == nil {
		return nil, errors.New("debug session not found")
	}
	return s, nil
}

func (m *Manager) Snapshots() []Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]Snapshot, 0, len(m.order))
	for _, id := range m.order {
		result = append(result, m.sessions[id].Snapshot())
	}
	return result
}

func (m *Manager) Active() bool {
	for _, s := range m.Snapshots() {
		if s.State != "terminated" && s.State != "disconnected" && s.State != "failed" {
			return true
		}
	}
	return false
}

func (m *Manager) Close(ctx context.Context) error {
	m.mu.RLock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.mu.RUnlock()
	// Close sessions concurrently so a slow external server cannot delay all others.
	errs := make(chan error, len(sessions))
	var wg sync.WaitGroup
	for _, s := range sessions {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- s.Disconnect(ctx, s.config.Kind == "launch") }()
	}
	wg.Wait()
	close(errs)
	var all []error
	for err := range errs {
		if err != nil {
			all = append(all, err)
		}
	}
	return errors.Join(all...)
}

func (m *Manager) Remove(id string) error {
	s, err := m.Session(id)
	if err != nil {
		return err
	}
	state := s.Snapshot().State
	if state != "terminated" && state != "disconnected" && state != "failed" {
		return errors.New("disconnect or stop the session before removing it")
	}
	s.cleanup()
	m.mu.Lock()
	delete(m.sessions, id)
	for i, item := range m.order {
		if item == id {
			m.order = append(m.order[:i], m.order[i+1:]...)
			break
		}
	}
	m.mu.Unlock()
	return nil
}

func cloneBreakpoints(in map[string][]Breakpoint) map[string][]Breakpoint {
	out := make(map[string][]Breakpoint, len(in))
	for path, items := range in {
		out[path] = append([]Breakpoint{}, items...)
	}
	return out
}

func sortedLines(items []Breakpoint) []Breakpoint {
	copy := append([]Breakpoint{}, items...)
	sort.Slice(copy, func(i, j int) bool { return copy[i].Line < copy[j].Line })
	return copy
}
