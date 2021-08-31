/*
Copyright 2016 OpenMarket Ltd
Copyright 2018 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React, {createRef} from 'react';
import ReactDOM from 'react-dom';
import PropTypes from 'prop-types';
import classNames from 'classnames';
import shouldHideEvent from '../../shouldHideEvent';
import * as sdk from '../../index';

import {MatrixClientPeg} from '../../MatrixClientPeg';
import SettingsStore from '../../settings/SettingsStore';
import {Layout, LayoutPropType} from "../../settings/Layout";
import {_t} from "../../languageHandler";
import {haveTileForEvent} from "../views/rooms/PostEventTile";
import {textForEvent} from "../../TextForEvent";
import IRCTimelineProfileResizer from "../views/elements/IRCTimelineProfileResizer";
import DMRoomMap from "../../utils/DMRoomMap";
import NewRoomIntro from "../views/rooms/NewRoomIntro";
import {replaceableComponent} from "../../utils/replaceableComponent";
import defaultDispatcher from '../../dispatcher/dispatcher';

const CONTINUATION_MAX_INTERVAL = 5 * 60 * 1000; // 5 minutes
const continuedTypes = ['m.sticker', 'm.room.message'];
const messageTypes = ['m.sticker', 'm.room.message'];

// check if there is a previous event and it has the same sender as this event
// and the types are the same/is in continuedTypes and the time between them is <= CONTINUATION_MAX_INTERVAL
function shouldFormContinuation(prevEvent, mxEvent) {
    // sanity check inputs
    if (!prevEvent || !prevEvent.sender || !mxEvent.sender) return false;
    // check if within the max continuation period
    if (mxEvent.getTs() - prevEvent.getTs() > CONTINUATION_MAX_INTERVAL) return false;

    // As we summarise redactions, do not continue a redacted event onto a non-redacted one and vice-versa
    if (mxEvent.isRedacted() !== prevEvent.isRedacted()) return false;

    // Some events should appear as continuations from previous events of different types.
    if (mxEvent.getType() !== prevEvent.getType() &&
        (!continuedTypes.includes(mxEvent.getType()) ||
            !continuedTypes.includes(prevEvent.getType()))) return false;

    // Check if the sender is the same and hasn't changed their displayname/avatar between these events
    if (mxEvent.sender.userId !== prevEvent.sender.userId ||
        mxEvent.sender.name !== prevEvent.sender.name ||
        mxEvent.sender.getMxcAvatarUrl() !== prevEvent.sender.getMxcAvatarUrl()) return false;

    // if we don't have tile for previous event then it was shown by showHiddenEvents and has no SenderProfile
    if (!haveTileForEvent(prevEvent)) return false;

    return true;
}

const isMembershipChange = (e) => e.getType() === 'm.room.member' || e.getType() === 'm.room.third_party_invite';

/* (almost) stateless UI component which builds the event tiles in the room timeline.
 */
@replaceableComponent("structures.PostPanel")
export default class PostPanel extends React.Component {
    static propTypes = {
        // true to give the component a 'display: none' style.
        hidden: PropTypes.bool,

        // true to show a spinner at the top of the timeline to indicate
        // back-pagination in progress
        backPaginating: PropTypes.bool,

        // true to show a spinner at the end of the timeline to indicate
        // forward-pagination in progress
        forwardPaginating: PropTypes.bool,

        // the list of MatrixEvents to display
        events: PropTypes.array.isRequired,

        // ID of an event to highlight. If undefined, no event will be highlighted.
        highlightedEventId: PropTypes.string,

        // The room these events are all in together, if any.
        // (The notification panel won't have a room here, for example.)
        room: PropTypes.object,

        // Should we show URL Previews
        showUrlPreview: PropTypes.bool,

        // event after which we should show a read marker
        readMarkerEventId: PropTypes.string,

        // whether the read marker should be visible
        readMarkerVisible: PropTypes.bool,

        // the userid of our user. This is used to suppress the read marker
        // for pending messages.
        ourUserId: PropTypes.string,

        // true to suppress the date at the start of the timeline
        suppressFirstDateSeparator: PropTypes.bool,

        // whether to show read receipts
        showReadReceipts: PropTypes.bool,

        // true if updates to the event list should cause the scroll panel to
        // scroll down when we are at the bottom of the window. See ScrollPanel
        // for more details.
        stickyBottom: PropTypes.bool,

        // callback which is called when the panel is scrolled.
        onScroll: PropTypes.func,

        // callback which is called when more content is needed.
        onFillRequest: PropTypes.func,

        // className for the panel
        className: PropTypes.string.isRequired,

        // shape parameter to be passed to EventTiles
        tileShape: PropTypes.string,

        // show twelve hour timestamps
        isTwelveHour: PropTypes.bool,

        // show timestamps always
        alwaysShowTimestamps: PropTypes.bool,

        // helper function to access relations for an event
        getRelationsForEvent: PropTypes.func,

        // whether to show reactions for an event
        showReactions: PropTypes.bool,

        // which layout to use
        layout: LayoutPropType,

        // whether or not to show flair at all
        enableFlair: PropTypes.bool,
    };

    constructor(props) {
        super(props);

        this.state = {
            // previous positions the read marker has been in, so we can
            // display 'ghost' read markers that are animating away
            ghostReadMarkers: [],
            showTypingNotifications: SettingsStore.getValue("showTypingNotifications"),
        };

        // opaque readreceipt info for each userId; used by ReadReceiptMarker
        // to manage its animations
        this._readReceiptMap = {};

        // Track read receipts by event ID. For each _shown_ event ID, we store
        // the list of read receipts to display:
        //   [
        //       {
        //           userId: string,
        //           member: RoomMember,
        //           ts: number,
        //       },
        //   ]
        // This is recomputed on each render. It's only stored on the component
        // for ease of passing the data around since it's computed in one pass
        // over all events.
        this._readReceiptsByEvent = {};

        // Track read receipts by user ID. For each user ID we've ever shown a
        // a read receipt for, we store an object:
        //   {
        //       lastShownEventId: string,
        //       receipt: {
        //           userId: string,
        //           member: RoomMember,
        //           ts: number,
        //       },
        //   }
        // so that we can always keep receipts displayed by reverting back to
        // the last shown event for that user ID when needed. This may feel like
        // it duplicates the receipt storage in the room, but at this layer, we
        // are tracking _shown_ event IDs, which the JS SDK knows nothing about.
        // This is recomputed on each render, using the data from the previous
        // render as our fallback for any user IDs we can't match a receipt to a
        // displayed event in the current render cycle.
        this._readReceiptsByUserId = {};

        // Cache hidden events setting on mount since Settings is expensive to
        // query, and we check this in a hot code path.
        this._showHiddenEventsInTimeline =
            SettingsStore.getValue("showHiddenEventsInTimeline");

        this._isMounted = false;

        this._readMarkerNode = createRef();
        this._whoIsTyping = createRef();
        this._scrollPanel = createRef();

        this._showTypingNotificationsWatcherRef =
            SettingsStore.watchSetting("showTypingNotifications", null, this.onShowTypingNotificationsChange);
    }

    componentDidMount() {
        this._isMounted = true;
    }

    componentWillUnmount() {
        this._isMounted = false;
        SettingsStore.unwatchSetting(this._showTypingNotificationsWatcherRef);
    }

    componentDidUpdate(prevProps, prevState) {
        if (prevProps.readMarkerVisible && this.props.readMarkerEventId !== prevProps.readMarkerEventId) {
            const ghostReadMarkers = this.state.ghostReadMarkers;
            ghostReadMarkers.push(prevProps.readMarkerEventId);
            this.setState({
                ghostReadMarkers,
            });
        }
    }

    onShowTypingNotificationsChange = () => {
        this.setState({
            showTypingNotifications: SettingsStore.getValue("showTypingNotifications"),
        });
    };

    /* get the DOM node representing the given event */
    getNodeForEventId(eventId) {
        if (!this.eventNodes) {
            return undefined;
        }

        return this.eventNodes[eventId];
    }

    /* return true if the content is fully scrolled down right now; else false.
     */
    isAtBottom() {
        return this._scrollPanel.current && this._scrollPanel.current.isAtBottom();
    }

    /* get the current scroll state. See ScrollPanel.getScrollState for
     * details.
     *
     * returns null if we are not mounted.
     */
    getScrollState() {
        return this._scrollPanel.current ? this._scrollPanel.current.getScrollState() : null;
    }

    // returns one of:
    //
    //  null: there is no read marker
    //  -1: read marker is above the window
    //   0: read marker is within the window
    //  +1: read marker is below the window
    getReadMarkerPosition() {
        const readMarker = this._readMarkerNode.current;
        const messageWrapper = this._scrollPanel.current;

        if (!readMarker || !messageWrapper) {
            return null;
        }

        const wrapperRect = ReactDOM.findDOMNode(messageWrapper).getBoundingClientRect();
        const readMarkerRect = readMarker.getBoundingClientRect();

        // the read-marker pretends to have zero height when it is actually
        // two pixels high; +2 here to account for that.
        if (readMarkerRect.bottom + 2 < wrapperRect.top) {
            return -1;
        } else if (readMarkerRect.top < wrapperRect.bottom) {
            return 0;
        } else {
            return 1;
        }
    }

    /* jump to the top of the content.
     */
    scrollToTop() {
        if (this._scrollPanel.current) {
            this._scrollPanel.current.scrollToTop();
        }
    }

    /* jump to the bottom of the content.
     */
    scrollToBottom() {
        if (this._scrollPanel.current) {
            this._scrollPanel.current.scrollToBottom();
        }
    }

    /**
     * Page up/down.
     *
     * @param {number} mult: -1 to page up, +1 to page down
     */
    scrollRelative(mult) {
        if (this._scrollPanel.current) {
            this._scrollPanel.current.scrollRelative(mult);
        }
    }

    /**
     * Scroll up/down in response to a scroll key
     *
     * @param {KeyboardEvent} ev: the keyboard event to handle
     */
    handleScrollKey(ev) {
        if (this._scrollPanel.current) {
            this._scrollPanel.current.handleScrollKey(ev);
        }
    }

    /* jump to the given event id.
     *
     * offsetBase gives the reference point for the pixelOffset. 0 means the
     * top of the container, 1 means the bottom, and fractional values mean
     * somewhere in the middle. If omitted, it defaults to 0.
     *
     * pixelOffset gives the number of pixels *above* the offsetBase that the
     * node (specifically, the bottom of it) will be positioned. If omitted, it
     * defaults to 0.
     */
    scrollToEvent(eventId, pixelOffset, offsetBase) {
        if (this._scrollPanel.current) {
            this._scrollPanel.current.scrollToToken(eventId, pixelOffset, offsetBase);
        }
    }

    scrollToEventIfNeeded(eventId) {
        const node = this.eventNodes[eventId];
        if (node) {
            node.scrollIntoView({block: "nearest", behavior: "instant"});
        }
    }

    /* check the scroll state and send out pagination requests if necessary.
     */
    checkFillState() {
        if (this._scrollPanel.current) {
            this._scrollPanel.current.checkFillState();
        }
    }

    _isUnmounting = () => {
        return !this._isMounted;
    };

    // TODO: Implement granular (per-room) hide options
    _shouldShowEvent(mxEv) {
        if (mxEv.sender && MatrixClientPeg.get().isUserIgnored(mxEv.sender.userId)) {
            return false; // ignored = no show (only happens if the ignore happens after an event was received)
        }

        if (!messageTypes.includes(mxEv.getType())) {
            return false;
        }

        const mRelatesTo = mxEv.getWireContent()['m.relates_to'];
        if (mRelatesTo && mRelatesTo['m.in_reply_to']) {
            return false
        }

        if (mxEv.isRedacted()) {
            return false;
        }

        if (this._showHiddenEventsInTimeline) {
            return true;
        }

        if (!haveTileForEvent(mxEv)) {
            return false; // no tile = no show
        }

        // Always show highlighted event
        if (this.props.highlightedEventId === mxEv.getId()) return true;

        return !shouldHideEvent(mxEv);
    }

    _readMarkerForEvent(eventId, isLastEvent) {
        const visible = !isLastEvent && this.props.readMarkerVisible;

        if (this.props.readMarkerEventId === eventId) {
            let hr;
            // if the read marker comes at the end of the timeline (except
            // for local echoes, which are excluded from RMs, because they
            // don't have useful event ids), we don't want to show it, but
            // we still want to create the <li/> for it so that the
            // algorithms which depend on its position on the screen aren't
            // confused.
            if (visible) {
                hr = <hr className="mx_RoomView_myReadMarker"
                    style={{opacity: 1, width: '99%'}}
                />;
            }

            return (
                <li key={"readMarker_"+eventId}
                    ref={this._readMarkerNode}
                    className="mx_RoomView_myReadMarker_container"
                    data-scroll-tokens={eventId}
                >
                    { hr }
                </li>
            );
        } else if (this.state.ghostReadMarkers.includes(eventId)) {
            // We render 'ghost' read markers in the DOM while they
            // transition away. This allows the actual read marker
            // to be in the right place straight away without having
            // to wait for the transition to finish.
            // There are probably much simpler ways to do this transition,
            // possibly using react-transition-group which handles keeping
            // elements in the DOM whilst they transition out, although our
            // case is a little more complex because only some of the items
            // transition (ie. the read markers do but the event tiles do not)
            // and TransitionGroup requires that all its children are Transitions.
            const hr = <hr className="mx_RoomView_myReadMarker"
                ref={this._collectGhostReadMarker}
                onTransitionEnd={this._onGhostTransitionEnd}
                data-eventid={eventId}
            />;

            // give it a key which depends on the event id. That will ensure that
            // we get a new DOM node (restarting the animation) when the ghost
            // moves to a different event.
            return (
                <li
                    key={"_readuptoghost_"+eventId}
                    className="mx_RoomView_myReadMarker_container"
                >
                    { hr }
                </li>
            );
        }

        return null;
    }

    _collectGhostReadMarker = (node) => {
        if (node) {
            // now the element has appeared, change the style which will trigger the CSS transition
            requestAnimationFrame(() => {
                node.style.width = '10%';
                node.style.opacity = '0';
            });
        }
    };

    _onGhostTransitionEnd = (ev) => {
        // we can now clean up the ghost element
        const finishedEventId = ev.target.dataset.eventid;
        this.setState({
            ghostReadMarkers: this.state.ghostReadMarkers.filter(eid => eid !== finishedEventId),
        });
    };

    _getNextEventInfo(arr, i) {
        const nextEvent = i < arr.length - 1
            ? arr[i + 1]
            : null;

        // The next event with tile is used to to determine the 'last successful' flag
        // when rendering the tile. The shouldShowEvent function is pretty quick at what
        // it does, so this should have no significant cost even when a room is used for
        // not-chat purposes.
        const nextTile = arr.slice(i + 1).find(e => this._shouldShowEvent(e));

        return {nextEvent, nextTile};
    }

    get _roomHasPendingEdit() {
        return this.props.room && localStorage.getItem(`mx_edit_room_${this.props.room.roomId}`);
    }

    _getEventTiles() {
        this.eventNodes = {};

        let i;

        // first figure out which is the last event in the list which we're
        // actually going to show; this allows us to behave slightly
        // differently for the last event in the list. (eg show timestamp)
        //
        // we also need to figure out which is the last event we show which isn't
        // a local echo, to manage the read-marker.
        let lastShownEvent;

        let lastShownNonLocalEchoIndex = -1;
        for (i = this.props.events.length-1; i >= 0; i--) {
            const mxEv = this.props.events[i];
            if (!this._shouldShowEvent(mxEv)) {
                continue;
            }

            if (lastShownEvent === undefined) {
                lastShownEvent = mxEv;
            }

            if (mxEv.status) {
                // this is a local echo
                continue;
            }

            lastShownNonLocalEchoIndex = i;
            break;
        }

        const ret = [];

        let prevEvent = null; // the last event we showed

        // Note: the EventTile might still render a "sent/sending receipt" independent of
        // this information. When not providing read receipt information, the tile is likely
        // to assume that sent receipts are to be shown more often.
        this._readReceiptsByEvent = {};
        if (this.props.showReadReceipts) {
            this._readReceiptsByEvent = this._getReadReceiptsByShownEvent();
        }


        for (i = 0; i < this.props.events.length; i++) {
            const mxEv = this.props.events[i];
            const eventId = mxEv.getId();
            const last = (mxEv === lastShownEvent);
            const {nextEvent, nextTile} = this._getNextEventInfo(this.props.events, i);

            const wantTile = this._shouldShowEvent(mxEv);
            const isGrouped = false;
            if (wantTile) {
                // make sure we unpack the array returned by _getTilesForEvent,
                // otherwise react will auto-generate keys and we will end up
                // replacing all of the DOM elements every time we paginate.
                ret.push(...this._getTilesForEvent(prevEvent, mxEv, last, false,
                    nextEvent, nextTile));
                prevEvent = mxEv;
            }

            const readMarker = this._readMarkerForEvent(eventId, i >= lastShownNonLocalEchoIndex);
            if (readMarker) ret.push(readMarker);
        }

        if (!this.props.editState && this._roomHasPendingEdit) {
            defaultDispatcher.dispatch({
                action: "edit_event",
                event: this.props.room.findEventById(this._roomHasPendingEdit),
            });
        }

        return ret;
    }

    _getTilesForEvent(prevEvent, mxEv, last, isGrouped=false, nextEvent, nextEventWithTile, level=0) {
        const TileErrorBoundary = sdk.getComponent('messages.TileErrorBoundary');
        const PostEventTile = sdk.getComponent('rooms.PostEventTile');
        const ret = [];

        const isEditing = this.props.editState &&
            this.props.editState.getEvent().getId() === mxEv.getId();
        // local echoes have a fake date, which could even be yesterday. Treat them
        // as 'today' for the date separators.
        let ts1 = mxEv.getTs();
        let eventDate = mxEv.getDate();
        if (mxEv.status) {
            eventDate = new Date();
            ts1 = eventDate.getTime();
        }

        const continuation = shouldFormContinuation(prevEvent, mxEv);

        const eventId = mxEv.getId();
        const highlight = (eventId === this.props.highlightedEventId);

        // we can't use local echoes as scroll tokens, because their event IDs change.
        // Local echos have a send "status".
        const scrollToken = mxEv.status ? undefined : eventId;

        const readReceipts = this._readReceiptsByEvent[eventId];

        let isLastSuccessful = false;
        const isSentState = s => !s || s === 'sent';
        const isSent = isSentState(mxEv.getAssociatedStatus());
        const hasNextEvent = nextEvent && this._shouldShowEvent(nextEvent);
        if (!hasNextEvent && isSent) {
            isLastSuccessful = true;
        } else if (hasNextEvent && isSent && !isSentState(nextEvent.getAssociatedStatus())) {
            isLastSuccessful = true;
        }

        // This is a bit nuanced, but if our next event is hidden but a future event is not
        // hidden then we're not the last successful.
        if (
            nextEventWithTile &&
            nextEventWithTile !== nextEvent &&
            isSentState(nextEventWithTile.getAssociatedStatus())
        ) {
            isLastSuccessful = false;
        }

        // We only want to consider "last successful" if the event is sent by us, otherwise of course
        // it's successful: we received it.
        isLastSuccessful = isLastSuccessful && mxEv.getSender() === MatrixClientPeg.get().getUserId();

        // Get the direct comments of the event
        const directSubevents = this.props.events
            .filter((e) => e.getWireContent()['m.relates_to'] && e.getWireContent()['m.relates_to']['m.in_reply_to'])
            .filter((e) => e.getWireContent()['m.relates_to']['m.in_reply_to']['event_id'] === mxEv.getId())

        // use txnId as key if available so that we don't remount during sending
        ret.push(
            <li
                key={mxEv.getTxnId() || eventId}
                ref={this._collectEventNode.bind(this, eventId)}
                data-scroll-tokens={scrollToken}
            >
                <TileErrorBoundary mxEvent={mxEv}>
                    <PostEventTile
                        level={level}
                        mxEvent={mxEv}
                        continuation={continuation}
                        isRedacted={mxEv.isRedacted()}
                        replacingEventId={mxEv.replacingEventId()}
                        editState={isEditing && this.props.editState}
                        onHeightChanged={this._onHeightChanged}
                        readReceipts={readReceipts}
                        readReceiptMap={this._readReceiptMap}
                        showUrlPreview={this.props.showUrlPreview}
                        checkUnmounting={this._isUnmounting}
                        eventSendStatus={mxEv.getAssociatedStatus()}
                        tileShape={this.props.tileShape}
                        isTwelveHour={this.props.isTwelveHour}
                        permalinkCreator={this.props.permalinkCreator}
                        last={last}
                        lastInSection={false}
                        lastSuccessful={isLastSuccessful}
                        isSelectedEvent={highlight}
                        getRelationsForEvent={this.props.getRelationsForEvent}
                        showReactions={this.props.showReactions}
                        layout={this.props.layout}
                        enableFlair={this.props.enableFlair}
                        showReadReceipts={this.props.showReadReceipts}
                    />
                    {directSubevents.map((e) => this._getTilesForEvent(
                        null,
                        e,
                        null,
                        false,
                        null,
                        null,
                        level + 1,
                    ))}
                </TileErrorBoundary>
            </li>,
        );

        return ret;
    }

    // Get a list of read receipts that should be shown next to this event
    // Receipts are objects which have a 'userId', 'roomMember' and 'ts'.
    _getReadReceiptsForEvent(event) {
        const myUserId = MatrixClientPeg.get().credentials.userId;

        // get list of read receipts, sorted most recent first
        const { room } = this.props;
        if (!room) {
            return null;
        }
        const receipts = [];
        room.getReceiptsForEvent(event).forEach((r) => {
            if (!r.userId || r.type !== "m.read" || r.userId === myUserId) {
                return; // ignore non-read receipts and receipts from self.
            }
            if (MatrixClientPeg.get().isUserIgnored(r.userId)) {
                return; // ignore ignored users
            }
            const member = room.getMember(r.userId);
            receipts.push({
                userId: r.userId,
                roomMember: member,
                ts: r.data ? r.data.ts : 0,
            });
        });
        return receipts;
    }

    // Get an object that maps from event ID to a list of read receipts that
    // should be shown next to that event. If a hidden event has read receipts,
    // they are folded into the receipts of the last shown event.
    _getReadReceiptsByShownEvent() {
        const receiptsByEvent = {};
        const receiptsByUserId = {};

        let lastShownEventId;
        for (const event of this.props.events) {
            if (this._shouldShowEvent(event)) {
                lastShownEventId = event.getId();
            }
            if (!lastShownEventId) {
                continue;
            }

            const existingReceipts = receiptsByEvent[lastShownEventId] || [];
            const newReceipts = this._getReadReceiptsForEvent(event);
            receiptsByEvent[lastShownEventId] = existingReceipts.concat(newReceipts);

            // Record these receipts along with their last shown event ID for
            // each associated user ID.
            for (const receipt of newReceipts) {
                receiptsByUserId[receipt.userId] = {
                    lastShownEventId,
                    receipt,
                };
            }
        }

        // It's possible in some cases (for example, when a read receipt
        // advances before we have paginated in the new event that it's marking
        // received) that we can temporarily not have a matching event for
        // someone which had one in the last. By looking through our previous
        // mapping of receipts by user ID, we can cover recover any receipts
        // that would have been lost by using the same event ID from last time.
        for (const userId in this._readReceiptsByUserId) {
            if (receiptsByUserId[userId]) {
                continue;
            }
            const { lastShownEventId, receipt } = this._readReceiptsByUserId[userId];
            const existingReceipts = receiptsByEvent[lastShownEventId] || [];
            receiptsByEvent[lastShownEventId] = existingReceipts.concat(receipt);
            receiptsByUserId[userId] = { lastShownEventId, receipt };
        }
        this._readReceiptsByUserId = receiptsByUserId;

        // After grouping receipts by shown events, do another pass to sort each
        // receipt list.
        for (const eventId in receiptsByEvent) {
            receiptsByEvent[eventId].sort((r1, r2) => {
                return r2.ts - r1.ts;
            });
        }

        return receiptsByEvent;
    }

    _collectEventNode = (eventId, node) => {
        this.eventNodes[eventId] = node;
    }

    // once dynamic content in the events load, make the scrollPanel check the
    // scroll offsets.
    _onHeightChanged = () => {
        const scrollPanel = this._scrollPanel.current;
        if (scrollPanel) {
            scrollPanel.checkScroll();
        }
    };

    _onTypingShown = () => {
        const scrollPanel = this._scrollPanel.current;
        // this will make the timeline grow, so checkScroll
        scrollPanel.checkScroll();
        if (scrollPanel && scrollPanel.getScrollState().stuckAtBottom) {
            scrollPanel.preventShrinking();
        }
    };

    _onTypingHidden = () => {
        const scrollPanel = this._scrollPanel.current;
        if (scrollPanel) {
            // as hiding the typing notifications doesn't
            // update the scrollPanel, we tell it to apply
            // the shrinking prevention once the typing notifs are hidden
            scrollPanel.updatePreventShrinking();
            // order is important here as checkScroll will scroll down to
            // reveal added padding to balance the notifs disappearing.
            scrollPanel.checkScroll();
        }
    };

    updateTimelineMinHeight() {
        const scrollPanel = this._scrollPanel.current;

        if (scrollPanel) {
            const isAtBottom = scrollPanel.isAtBottom();
            const whoIsTyping = this._whoIsTyping.current;
            const isTypingVisible = whoIsTyping && whoIsTyping.isVisible();
            // when messages get added to the timeline,
            // but somebody else is still typing,
            // update the min-height, so once the last
            // person stops typing, no jumping occurs
            if (isAtBottom && isTypingVisible) {
                scrollPanel.preventShrinking();
            }
        }
    }

    onTimelineReset() {
        const scrollPanel = this._scrollPanel.current;
        if (scrollPanel) {
            scrollPanel.clearPreventShrinking();
        }
    }

    render() {
        const ErrorBoundary = sdk.getComponent('elements.ErrorBoundary');
        const ScrollPanel = sdk.getComponent("structures.ScrollPanel");
        const WhoIsTypingTile = sdk.getComponent("rooms.WhoIsTypingTile");
        const Spinner = sdk.getComponent("elements.Spinner");
        let topSpinner;
        let bottomSpinner;
        if (this.props.backPaginating) {
            topSpinner = <li key="_topSpinner"><Spinner /></li>;
        }
        if (this.props.forwardPaginating) {
            bottomSpinner = <li key="_bottomSpinner"><Spinner /></li>;
        }

        const style = this.props.hidden ? { display: 'none' } : {};

        const className = classNames(
            this.props.className,
            {
                "mx_PostPanel_alwaysShowTimestamps": this.props.alwaysShowTimestamps,
            },
        );

        let whoIsTyping;
        if (this.props.room && !this.props.tileShape && this.state.showTypingNotifications) {
            whoIsTyping = (<WhoIsTypingTile
                room={this.props.room}
                onShown={this._onTypingShown}
                onHidden={this._onTypingHidden}
                ref={this._whoIsTyping} />
            );
        }

        let ircResizer = null;
        if (this.props.layout == Layout.IRC) {
            ircResizer = <IRCTimelineProfileResizer
                minWidth={20}
                maxWidth={600}
                roomId={this.props.room ? this.props.room.roomId : null}
            />;
        }

        return (
            <ErrorBoundary>
                <ScrollPanel
                    ref={this._scrollPanel}
                    className={className}
                    onScroll={this.props.onScroll}
                    onResize={this.onResize}
                    onFillRequest={this.props.onFillRequest}
                    onUnfillRequest={this.props.onUnfillRequest}
                    style={style}
                    stickyBottom={this.props.stickyBottom}
                    resizeNotifier={this.props.resizeNotifier}
                    fixedChildren={ircResizer}
                >
                    { topSpinner }
                    { this._getEventTiles() }
                    { whoIsTyping }
                    { bottomSpinner }
                </ScrollPanel>
            </ErrorBoundary>
        );
    }
}
