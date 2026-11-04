// Package events fans server events out to each user's connected clients (tabs and devices).
package events

import "context"

// Event is one server-sent event, e.g. {Type: "timer", Data: engine.State}.
type Event struct {
	Type string
	Data any
}

type subscription struct {
	userID uint
	ch     chan Event
}

type message struct {
	userID uint
	event  Event
}

// Hub is a publish/subscribe broker owned by one goroutine (Run). Subscribes,
// unsubscribes and publishes all arrive over channels, so its subscriber map
// is never shared and needs no lock.
type Hub struct {
	subscribe   chan subscription
	unsubscribe chan subscription
	publish     chan message
	done        chan struct{}
}

// Buffer is how many undelivered events a client may fall behind by before it is disconnected.
const Buffer = 16

// NewHub returns a hub. Nothing is delivered until Run is started.
func NewHub() *Hub {
	return &Hub{
		subscribe:   make(chan subscription),
		unsubscribe: make(chan subscription),
		publish:     make(chan message, 64),
		done:        make(chan struct{}),
	}
}

// Run delivers events until ctx is cancelled, then closes every subscriber's channel.
func (h *Hub) Run(ctx context.Context) {
	defer close(h.done)
	subs := make(map[uint]map[chan Event]struct{})
	drop := func(userID uint, ch chan Event) {
		if _, ok := subs[userID][ch]; ok {
			delete(subs[userID], ch)
			close(ch)
			if len(subs[userID]) == 0 {
				delete(subs, userID)
			}
		}
	}

	for {
		select {
		case <-ctx.Done():
			for userID, set := range subs {
				for ch := range set {
					drop(userID, ch)
				}
			}
			return
		case s := <-h.subscribe:
			if subs[s.userID] == nil {
				subs[s.userID] = make(map[chan Event]struct{})
			}
			subs[s.userID][s.ch] = struct{}{}
		case s := <-h.unsubscribe:
			drop(s.userID, s.ch)
		case m := <-h.publish:
			for ch := range subs[m.userID] {
				select {
				case ch <- m.event:
				default:
					// A client this far behind is disconnected rather than allowed to block
					// everyone else. Its browser reconnects and receives a fresh snapshot.
					drop(m.userID, ch)
				}
			}
		}
	}
}

// Subscribe registers a client for userID's events. The channel closes when the
// client is dropped or the hub stops; call cancel when the client disconnects.
func (h *Hub) Subscribe(userID uint) (events <-chan Event, cancel func()) {
	s := subscription{userID: userID, ch: make(chan Event, Buffer)}
	select {
	case h.subscribe <- s:
	case <-h.done:
		close(s.ch)
		return s.ch, func() {}
	}
	return s.ch, func() {
		select {
		case h.unsubscribe <- s:
		case <-h.done:
		}
	}
}

// Publish sends an event to all of userID's clients. It never blocks on a slow client.
func (h *Hub) Publish(userID uint, e Event) {
	select {
	case h.publish <- message{userID: userID, event: e}:
	case <-h.done:
	}
}
