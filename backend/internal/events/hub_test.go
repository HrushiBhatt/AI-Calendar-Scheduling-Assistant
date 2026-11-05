package events

import (
	"context"
	"testing"
	"time"
)

func startHub(t *testing.T) *Hub {
	t.Helper()
	h := NewHub()
	go h.Run(t.Context())
	return h
}

func receive(t *testing.T, ch <-chan Event) Event {
	t.Helper()
	select {
	case e, ok := <-ch:
		if !ok {
			t.Fatal("channel closed")
		}
		return e
	case <-time.After(time.Second):
		t.Fatal("no event within 1s")
	}
	return Event{}
}

func TestPublishReachesOnlyThatUsersClients(t *testing.T) {
	h := startHub(t)
	laptop, stopLaptop := h.Subscribe(1)
	defer stopLaptop()
	phone, stopPhone := h.Subscribe(1)
	defer stopPhone()
	other, stopOther := h.Subscribe(2)
	defer stopOther()

	h.Publish(1, Event{Type: "timer"})

	for _, ch := range []<-chan Event{laptop, phone} {
		if e := receive(t, ch); e.Type != "timer" {
			t.Fatalf("got %q", e.Type)
		}
	}
	select {
	case e := <-other:
		t.Fatalf("user 2 received user 1's event %q", e.Type)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestSlowClientIsDroppedWithoutBlockingOthers(t *testing.T) {
	h := startHub(t)
	slow, stopSlow := h.Subscribe(1) // never read
	defer stopSlow()
	fast, stopFast := h.Subscribe(1)
	defer stopFast()

	for i := range Buffer + 5 {
		h.Publish(1, Event{Type: "tick", Data: i})
		receive(t, fast) // keeps up
	}

	drained := 0
	for range slow {
		drained++
	}
	if drained != Buffer {
		t.Fatalf("slow client got %d events before being dropped, want %d", drained, Buffer)
	}
}

func TestStoppingTheHubClosesStreams(t *testing.T) {
	h := NewHub()
	ctx, stop := context.WithCancel(t.Context())
	go h.Run(ctx)
	ch, unsubscribe := h.Subscribe(1)
	stop()

	select {
	case _, open := <-ch:
		if open {
			t.Fatal("expected the stream to be closed")
		}
	case <-time.After(time.Second):
		t.Fatal("stream not closed on shutdown")
	}
	// Nothing may block once the hub has stopped.
	unsubscribe()
	h.Publish(1, Event{Type: "late"})
	if _, open := <-mustSubscribe(h); open {
		t.Fatal("subscribing after shutdown should yield a closed stream")
	}
}

func mustSubscribe(h *Hub) <-chan Event {
	ch, _ := h.Subscribe(1)
	return ch
}
