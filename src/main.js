import { scheduler } from "dhtmlx-scheduler";
import { db } from "./firebase.js";
import {
	collection,
	query,
	onSnapshot,
	addDoc,
	deleteDoc,
	Timestamp,
	orderBy,
	doc,
	updateDoc,
} from "firebase/firestore";

import "dhtmlx-scheduler/codebase/dhtmlxscheduler.css";

scheduler.plugins({
	recurring: true,
});

scheduler.config.header = [
	"day",
	"week",
	"month",
	"date",
	"prev",
	"today",
	"next",
];

scheduler.templates.parse_date = function (date) {
	if (!(date instanceof Date)) {
		date = new Date(date);
	}
	return date;
};

scheduler.init("scheduler_here", new Date(2022, 3, 20), "week");

const eventsRef = collection(db, "events");

scheduler.createDataProcessor(async function (entity, action, ev, id) {
	switch (action) {
		case "create":
			{
				if (ev._fromFirestore) return;
				const createdDoc = await addDoc(eventsRef, serialize(ev));
				if (createdDoc.id) {
					return { action: "inserted", tid: createdDoc.id };
				}
			}
			break;
		case "update":
			{
				return updateDoc(doc(db, "events", id), serialize(ev));
			}
			break;
		case "delete":
			{
				const deletedDoc = await deleteDoc(doc(db, "events", id));
				if (deletedDoc) {
					return { action: "deleted" };
				}
			}
			break;
	}
});

// Helper function to process event data
const processEvent = (docSnapshot) => {
	const event = docSnapshot.data();
	event.id = docSnapshot.id;
	["start_date", "end_date", "original_start"].forEach((field) => {
		if (event[field]) {
			try {
				const date = event[field].toDate
					? event[field].toDate()
					: new Date(event[field]);
				event[field] = date;
			} catch (e) {
				console.error(`Error processing ${field}:`, e);
				event[field] = null;
			}
		}
	});
	return event;
};
const q = query(eventsRef, orderBy("text", "desc")); // without it collection wouldn't call onSnapshot

onSnapshot(q, (querySnapshot) => {
	querySnapshot.docChanges().forEach((change) => {
		if (change.doc.metadata.hasPendingWrites) return;

		const event = processEvent(change.doc);

		// Only process server-side changes
		if (!change.doc.metadata.hasPendingWrites) {
			switch (change.type) {
				case "added":
					handleAddEvent(event);
					break;
				case "modified":
					handleUpdateEvent(event);
					break;
				case "removed":
					handleDeleteEvent(event);
					break;
			}
		}
	});
});

function handleAddEvent(eventData) {
	if (scheduler.getEvent(eventData.id)) {
		console.warn(
			`Event with ID ${eventData.id} already exists. Skipping add.`
		);
		return;
	}
	// Convert all date fields to Date objects if they aren't already
	const dateFields = ["start_date", "end_date", "original_start"];
	dateFields.forEach((field) => {
		if (eventData[field] && !(eventData[field] instanceof Date)) {
			eventData[field] = new Date(eventData[field]);
		}
	});

	ignore(() => {
		scheduler.addEvent(eventData);
	});
}

function handleUpdateEvent(eventData) {
	const sid = eventData.id;

	if (!scheduler.getEvent(sid)) {
		console.warn(`Event with ID ${sid} does not exist. Skipping update.`);
		return;
	}

	let existingEvent = scheduler.getEvent(sid);
	Object.assign(existingEvent, eventData);
	scheduler.updateEvent(sid);

	ignore(() => {
		// Update non-date fields if coming from server
		for (let key in eventData) {
			if (
				key !== "start_date" &&
				key !== "end_date" &&
				key !== "original_start"
			) {
				existingEvent[key] = eventData[key];
			}
		}

		scheduler.updateEvent(sid);

		if (sid !== eventData.id) {
			scheduler.changeEventId(sid, eventData.id);
		}
	});
}
function handleDeleteEvent(eventData) {
	const sid = eventData.id;

	if (!scheduler.getEvent(sid)) {
		if (eventData.event_pid) {
			ignore(() => {
				scheduler.addEvent(eventData);
			});
		}
		return;
	}

	ignore(() => {
		const event = scheduler.getEvent(sid);

		if (event) {
			// handle recurring event markers
			if (event.rec_type || event.rrule) {
				scheduler._roll_back_dates(event);

				const markers = scheduler._get_rec_markers(sid);
				for (const markerId in markers) {
					if (scheduler.getEvent(markerId)) {
						scheduler.deleteEvent(markerId, true);
					}
				}
			}

			// handle unsaved edits in the lightbox
			if (scheduler.getState().lightbox_id == sid) {
				this._new_event = this._lightbox_id;
				eventData.id = this._lightbox_id;
				this._events[this._lightbox_id] = eventData;
				if (
					scheduler.callEvent("onLiveUpdateCollision", [
						sid,
						null,
						"delete",
						eventData,
					]) === false
				) {
					// abort deletion if collision handler prevents it
					scheduler.endLightbox(false, scheduler._lightbox);
					return;
				}
			}

			// delete the event
			scheduler.deleteEvent(sid, true);
		}
	});
}

function ignore(code) {
	if (scheduler._dp) {
		scheduler._dp.ignore(code);
	} else {
		code();
	}
}

const serialize = (event) => {
	const filteredEvent = Object.fromEntries(
		Object.entries(event).filter(
			([key]) =>
				!key.startsWith("_") &&
				key !== "id" &&
				key !== "!nativeeditor_status"
		)
	);
	const serialized = { ...filteredEvent };
	serialized._fromFirestore = true; // Mark as coming from Firestore
	// Convert Date objects to Firestore Timestamps
	if (event.start_date instanceof Date) {
		serialized.start_date = Timestamp.fromDate(event.start_date);
	}
	if (event.end_date instanceof Date) {
		serialized.end_date = Timestamp.fromDate(event.end_date);
	}
	if (event.original_start instanceof Date) {
		serialized.original_start = Timestamp.fromDate(event.original_start);
	}

	return serialized;
};

// ---------- push directly: Scheduler → Firestore ----------
// scheduler.attachEvent("onEventAdded", async (id, ev) => {
// 	if (ev._fromFirestore) return; // Skip if this came from Firestore
// 	const { id: tmpId } = ev;
// 	try {
// 		const doc = await addDoc(eventsRef, serialize(ev));
// 		if (doc.id) {
// 			scheduler.changeEventId(tmpId, doc.id); // reconcile IDs
// 		}
// 	} catch (error) {
// 		console.error("Update failed:", error);
// 	}
// });

// scheduler.attachEvent("onEventChanged", async (id, ev) => {
// 	try {
// 		await updateDoc(doc(db, "events", id), serialize(ev));
// 	} catch (error) {
// 		console.error("Update failed:", error);
// 	}
// });

// scheduler.attachEvent("onEventDeleted", async (id) => {
// 	try {
// 		await deleteDoc(doc(db, "events", id));
// 	} catch (error) {
// 		console.error("Update failed:", error);
// 	}
// });
