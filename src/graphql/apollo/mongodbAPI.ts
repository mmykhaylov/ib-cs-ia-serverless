import { DataSource } from 'apollo-datasource';
import { UserInputError } from 'apollo-server-lambda';
import { Types } from 'mongoose';
import AppointmentModel, {
  AppointmentDocument,
  AppointmentDocumentObject,
  CreateAppointmentInput,
  CreateAppointmentMongoInput,
  UpdateAppointmentInput,
  UpdateAppointmentMongoInput,
} from '../models/Appointment';
import BarberModel, {
  BarberDocument,
  BarberDocumentPopulated,
  CreateBarberInput,
  CreateBarberMongoInput,
  UpdateBarberInput,
} from '../models/Barber';

const mongoDocToObject: (appointment: AppointmentDocument) => AppointmentDocumentObject = (
  appointment,
) => {
  // We convert Mongoose Document to object for cleanup
  const appointmentObject = appointment.toObject({ virtuals: true }) as AppointmentDocumentObject;
  return appointmentObject;
};

export type CreateAppointmentGraphQLApiInput = { input: CreateAppointmentInput };
export type GetAppointmentsGraphQLApiInput = { barberID?: string; date?: string };
export type GetAppointmentGraphQLApiInput = { appointmentID: string };
export type UpdateAppointmentGraphQLApiInput = {
  appointmentID: string;
  input: UpdateAppointmentInput;
};

export type CreateBarberGraphQLApiInput = { input: CreateBarberInput };
export type GetBarbersGraphQLApiInput = { dateTime?: string };
export type GetBarberGraphQLApiInput = { barberID?: string; email?: string };
export type UpdateBarberGraphQLApiInput = { barberID: string; input: UpdateBarberInput };

// In most cases what is passed to the GraphQL is passed to the MongoDB API
// However, when calling createBarber mutation, not all data should be stored
// Therefore it needs a separate type defined from MongoInput, not GraphQLApiInput
export type CreateAppointmentMongoApiInput = CreateAppointmentGraphQLApiInput;
export type GetAppointmentsMongoApiInput = GetAppointmentsGraphQLApiInput;
export type GetAppointmentMongoApiInput = GetAppointmentGraphQLApiInput;
export type UpdateAppointmentMongoApiInput = UpdateAppointmentGraphQLApiInput;

export type CreateBarberMongoApiInput = { input: CreateBarberMongoInput };
export type GetBarbersMongoApiInput = GetBarbersGraphQLApiInput;
export type GetBarberMongoApiInput = GetBarberGraphQLApiInput;
export type UpdateBarberMongoApiInput = UpdateBarberGraphQLApiInput;

class MongodbAPI extends DataSource {
  async getAppointments({
    barberID,
    date,
  }: GetAppointmentsMongoApiInput): Promise<AppointmentDocumentObject[]> {
    const searchCriteria: {
      barberID?: Types.ObjectId;
      time?: {
        $gte: Date;
        $lt: Date;
      };
    } = {};

    if (date) {
      // date: yyyy-mm-dd
      const [year, month, day] = date.split('-');
      // Subtracting 1 from month because in Date.UTC months start from 0
      searchCriteria.time = {
        $gte: new Date(Date.UTC(+year, +month - 1, +day)),
        $lt: new Date(Date.UTC(+year, +month - 1, +day + 1)),
      };
    }
    if (barberID) {
      searchCriteria.barberID = Types.ObjectId(barberID);
    }

    // Executing query with sorting by date ASC
    const foundAppointments = await AppointmentModel.find(searchCriteria, null, {
      sort: { time: 1 },
    });
    return Array.isArray(foundAppointments) ? foundAppointments.map(mongoDocToObject) : [];
  }

  async getAppointment({
    appointmentID,
  }: GetAppointmentMongoApiInput): Promise<AppointmentDocumentObject | undefined> {
    try {
      const foundAppointment = await AppointmentModel.findById(appointmentID);
      if (foundAppointment) {
        return mongoDocToObject(foundAppointment);
      }
    } catch (err) {
      throw new UserInputError('Appointment ID is invalid');
    }
  }

  async getBarbers({
    dateTime,
  }: GetBarbersMongoApiInput): Promise<Array<BarberDocument | BarberDocumentPopulated>> {
    //! The only time we populate an ID field
    // Other times ID is passed from prev resolver and we make a separate request
    let barbersRequest = BarberModel.find();
    if (!dateTime) {
      const foundBarbers = await barbersRequest.exec();
      return foundBarbers;
    } else {
      // If we recieve dateTime, it means we are looking for free barbers
      // Because of that, we populate the appointments of each...
      barbersRequest = barbersRequest.populate({ path: 'appointmentIDS' });
      const foundBarbers = ((await barbersRequest.exec()) as unknown) as BarberDocumentPopulated[];
      // ... and filter out barbers that have any appointment at specified time
      const freeBarbers = foundBarbers.filter(
        (barber) =>
          !barber.appointmentIDS.some(
            (appointment) => appointment.time.getTime() === new Date(dateTime).getTime(),
          ),
      );
      return freeBarbers;
    }
  }

  async getBarber({
    barberID,
    email,
  }: GetBarberMongoApiInput): Promise<BarberDocument | undefined> {
    let foundBarber: BarberDocument | null = null;
    if (barberID) {
      foundBarber = await BarberModel.findById(barberID);
    } else if (email) {
      foundBarber = await BarberModel.findOne({ email });
    }
    if (foundBarber) {
      return foundBarber;
    }
    throw new UserInputError('Barber not found');
  }

  async createAppointment({
    input,
  }: CreateAppointmentMongoApiInput): Promise<AppointmentDocumentObject> {
    // Checking if the barber with said ID exists
    const assignedBarber = await BarberModel.findById(input.barberID);
    if (!assignedBarber) {
      throw new UserInputError('Barber ID is invalid');
    }

    const appointmentData: CreateAppointmentMongoInput = { ...input, time: new Date(input.time) };
    const createdAppointment = await AppointmentModel.create(appointmentData);
    // Add appointment ID to barber's appointmentIDS array
    await BarberModel.findByIdAndUpdate(input.barberID, {
      $push: { appointmentIDS: createdAppointment._id },
    });
    return mongoDocToObject(createdAppointment);
  }

  async createBarber({ input }: CreateBarberMongoApiInput): Promise<BarberDocument> {
    const createdBarber = await BarberModel.create(input);
    return createdBarber;
  }

  async updateAppointment({
    appointmentID,
    input,
  }: UpdateAppointmentMongoApiInput): Promise<AppointmentDocumentObject> {
    const appointmentData: UpdateAppointmentMongoInput = {
      ...input,
      time: input.time ? new Date(input.time) : undefined,
    };
    const updatedAppointment = await AppointmentModel.findByIdAndUpdate(
      appointmentID,
      appointmentData,
      { new: true },
    );
    if (updatedAppointment) {
      return mongoDocToObject(updatedAppointment);
    }
    throw new UserInputError('Appointment not found');
  }

  async updateBarber({ barberID, input }: UpdateBarberMongoApiInput): Promise<BarberDocument> {
    const updatedBarber = await BarberModel.findByIdAndUpdate(barberID, input, { new: true });
    if (updatedBarber) {
      return updatedBarber;
    }
    throw new UserInputError('Barber not found');
  }
}

export default MongodbAPI;
