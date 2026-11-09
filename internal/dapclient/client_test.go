package dapclient

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/google/go-dap"
)

func readRequest(t *testing.T, r *bufio.Reader) Message {
	t.Helper()
	b, err := dap.ReadBaseMessage(r)
	if err != nil {
		t.Fatal(err)
	}
	var m Message
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func reply(t *testing.T, conn net.Conn, req Message, body any) {
	t.Helper()
	b, _ := json.Marshal(body)
	m, _ := json.Marshal(Message{Type: "response", Command: req.Command, RequestSeq: req.Seq, Success: true, Body: b})
	if err := dap.WriteBaseMessage(conn, m); err != nil {
		t.Error(err)
	}
}

func TestResponsesAreCorrelatedOutOfOrder(t *testing.T) {
	a, b := net.Pipe()
	c := New(a, nil)
	defer c.Close()
	defer b.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	go func() {
		r := bufio.NewReader(b)
		first, second := readRequest(t, r), readRequest(t, r)
		reply(t, b, second, map[string]int{"value": 2})
		reply(t, b, first, map[string]int{"value": 1})
	}()
	first, err := c.Start(ctx, "first", nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.Start(ctx, "second", nil)
	if err != nil {
		t.Fatal(err)
	}
	var one, two struct{ Value int }
	if err := second(&two); err != nil {
		t.Fatal(err)
	}
	if err := first(&one); err != nil {
		t.Fatal(err)
	}
	if one.Value != 1 || two.Value != 2 {
		t.Fatalf("wrong results: %v %v", one, two)
	}
}

func TestCancellationAndLateResponseDoNotBreakConnection(t *testing.T) {
	a, b := net.Pipe()
	c := New(a, nil)
	defer c.Close()
	defer b.Close()
	ctx, cancel := context.WithCancel(context.Background())
	requests := make(chan Message, 1)
	go func() { requests <- readRequest(t, bufio.NewReader(b)) }()
	wait, err := c.Start(ctx, "slow", nil)
	if err != nil {
		t.Fatal(err)
	}
	req := <-requests
	cancel()
	if !errors.Is(wait(nil), context.Canceled) {
		t.Fatal("expected cancellation")
	}
	reply(t, b, req, nil)
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	go func() { reply(t, b, readRequest(t, bufio.NewReader(b)), nil) }()
	if err := c.Call(ctx2, "next", nil, nil); err != nil {
		t.Fatal(err)
	}
}

func TestConnectionFailureWakesPendingRequests(t *testing.T) {
	a, b := net.Pipe()
	c := New(a, nil)
	defer c.Close()
	go func() { readRequest(t, bufio.NewReader(b)); _ = b.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Call(ctx, "pending", nil, nil); err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected connection error, got %v", err)
	}
}

func TestUnknownAdapterEventsArePreserved(t *testing.T) {
	a, b := net.Pipe()
	events := make(chan Message, 1)
	c := New(a, func(m Message) { events <- m })
	defer c.Close()
	defer b.Close()
	if err := dap.WriteBaseMessage(b, []byte(`{"seq":1,"type":"event","event":"adapterExtension","body":{"value":42}}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-events:
		if event.Event != "adapterExtension" {
			t.Fatal(event)
		}
	case <-time.After(time.Second):
		t.Fatal("event not delivered")
	}
}
